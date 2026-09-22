package com.recruit.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.recruit.common.MyException;
import com.recruit.dto.AiScoreRequestDTO;
import com.recruit.entity.Candidate;
import com.recruit.entity.CandidateApplication;
import com.recruit.entity.HrRequest;
import com.recruit.entity.ResumeScore;
import com.recruit.entity.ResumeVersion;
import com.recruit.event.ResumeVersionCreatedEvent;
import com.recruit.mapper.CandidateApplicationMapper;
import com.recruit.mapper.CandidateMapper;
import com.recruit.mapper.HrRequestMapper;
import com.recruit.mapper.ResumeScoreMapper;
import com.recruit.mapper.ResumeVersionMapper;
import com.recruit.vo.AiScoreResultVO;
import com.recruit.vo.ResumeScoreVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.util.StringUtils;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 简历 LLM 打分（采集落库后异步触发，结果落 resume_score 表）。
 *
 * <h3>链路</h3>
 * <pre>CollectService（事务内）发布 ResumeVersionCreatedEvent
 *   → AFTER_COMMIT（采集事务提交、投递事实已可见）
 *   → resumeScoreExecutor 异步线程执行 {@link #executeScore}
 *   → 组装简历文本 + JD → HTTP 调 recruit-ai-service → 结果 UPSERT 回 resume_score</pre>
 *
 * <h3>关键设计</h3>
 * <ul>
 *   <li><b>失败不传染</b>：LLM 超时/异常只落 failed 行，采集主流程完全不受影响（打分是增强能力，不是必经环节）；</li>
 *   <li><b>天然幂等</b>：事件只在<b>新建版本</b>时发布（版本去重跳过不发），同一份内容不会重复打分；
 *       手动重打按 uk(resume_version_id, request_key) UPSERT 覆盖旧结果；</li>
 *   <li><b>参照解析</b>：手动指定的 requestId 优先；否则取候选人最新投递解析到的 requestId
 *       （映射未建立时为 null → general 通用分析，映射建立后可手动重打为 match）；</li>
 *   <li><b>无长事务</b>：本类不持有跨 LLM 调用的事务 —— 打分一次几十秒，事务里的数据库连接
 *       必须在调用前归还。各落库步骤均为单语句更新。</li>
 * </ul>
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class ResumeScoreService {

    /** 简历文本上限：LLM 上下文足够，防极端脏数据撑爆 prompt */
    private static final int MAX_RESUME_TEXT_CHARS = 20000;

    private final ResumeScoreMapper resumeScoreMapper;
    private final CandidateMapper candidateMapper;
    private final ResumeVersionMapper resumeVersionMapper;
    private final CandidateApplicationMapper applicationMapper;
    private final HrRequestMapper hrRequestMapper;
    private final AiServiceClient aiServiceClient;

    // ==================================================================
    // 1) 触发入口（事件 / 手动重打）
    // ==================================================================

    /**
     * 采集事务提交后的异步打分入口。
     *
     * <p>AFTER_COMMIT 保证监听器执行时候选人/版本/投递事实都已真实落库；
     * {@code @Async} 把执行挪到打分专用线程池 —— LLM 几秒到几十秒的耗时
     * 不能占采集 HTTP 响应线程。</p>
     */
    @Async("resumeScoreExecutor")
    @TransactionalEventListener(classes = ResumeVersionCreatedEvent.class, phase = TransactionPhase.AFTER_COMMIT)
    public void onVersionCreated(ResumeVersionCreatedEvent event) {
        try {
            executeScore(event.candidateId(), event.resumeVersionId(), null);
        } catch (Exception e) {
            // 异步线程的异常没人接，必须自己兜住记日志
            log.error("事件打分异常: candidate={}, version={}",
                    event.candidateId(), event.resumeVersionId(), e);
        }
    }

    /**
     * 手动重打前置校验：候选人存在、有简历版本、指定的需求单存在。
     *
     * @return 最新简历版本 ID（重打对象）
     */
    public Long prepareRescore(Long candidateId, Long requestId) {
        if (candidateMapper.selectById(candidateId) == null) {
            throw new MyException(404, "候选人不存在");
        }
        List<ResumeVersion> latest = resumeVersionMapper.selectList(
                new LambdaQueryWrapper<ResumeVersion>()
                        .eq(ResumeVersion::getCandidateId, candidateId)
                        .orderByDesc(ResumeVersion::getId)
                        .last("LIMIT 1"));
        if (latest.isEmpty()) {
            throw new MyException(404, "该候选人尚无简历版本，无法打分");
        }
        if (requestId != null && hrRequestMapper.selectById(requestId) == null) {
            throw new MyException(404, "需求单不存在: " + requestId);
        }
        return latest.get(0).getId();
    }

    /** 手动重打（异步执行，接口立即返回；结果通过打分查询接口轮询/刷新查看） */
    @Async("resumeScoreExecutor")
    public void rescoreAsync(Long candidateId, Long resumeVersionId, Long requestId) {
        try {
            executeScore(candidateId, resumeVersionId, requestId);
        } catch (Exception e) {
            log.error("手动重打异常: candidate={}, version={}, request={}",
                    candidateId, resumeVersionId, requestId, e);
        }
    }

    // ==================================================================
    // 2) 查询
    // ==================================================================

    /** 候选人的打分结果列表（最新在前） */
    public List<ResumeScoreVO> scores(Long candidateId) {
        List<ResumeScore> rows = resumeScoreMapper.selectList(
                new LambdaQueryWrapper<ResumeScore>()
                        .eq(ResumeScore::getCandidateId, candidateId)
                        .orderByDesc(ResumeScore::getId));
        if (rows.isEmpty()) {
            return List.of();
        }
        List<Long> requestIds = rows.stream()
                .map(ResumeScore::getRequestId).filter(java.util.Objects::nonNull).distinct().toList();
        final Map<Long, HrRequest> requests = requestIds.isEmpty() ? Map.of()
                : hrRequestMapper.selectBatchIds(requestIds).stream()
                        .collect(Collectors.toMap(HrRequest::getId, Function.identity()));
        return rows.stream().map(r -> toVO(r, requests)).toList();
    }

    // ==================================================================
    // 3) 打分执行
    // ==================================================================

    private void executeScore(Long candidateId, Long resumeVersionId, Long forcedRequestId) {
        Candidate candidate = candidateMapper.selectById(candidateId);
        ResumeVersion version = resumeVersionMapper.selectById(resumeVersionId);
        if (candidate == null || version == null) {
            log.warn("打分跳过：候选人或简历版本不存在 candidate={}, version={}", candidateId, resumeVersionId);
            return;
        }

        // 参照需求单：手动指定优先；否则取最新投递解析到的 requestId
        CandidateApplication latestApp = latestApplication(candidateId);
        Long requestId = forcedRequestId != null ? forcedRequestId
                : (latestApp != null ? latestApp.getRequestId() : null);
        HrRequest request = requestId != null ? hrRequestMapper.selectById(requestId) : null;
        if (requestId != null && request == null) {
            // 防御：requestId 有值但需求单不存在（理论上不可能，映射解析自 publish_record）
            log.warn("打分降级为 general：requestId={} 对应需求单不存在", requestId);
            requestId = null;
        }
        boolean match = requestId != null;
        String requestKey = match ? "req:" + requestId : "general";
        String scoreType = match ? "match" : "general";
        // applicationId 只在投递与本次参照一致时冗余，避免张冠李戴
        Long applicationId = latestApp != null && requestId != null
                && requestId.equals(latestApp.getRequestId()) ? latestApp.getId() : null;

        Long rowId = upsertPending(candidateId, resumeVersionId, applicationId, requestId, requestKey, scoreType);

        AiScoreRequestDTO req = buildRequest(candidate, version, request);
        // 输入快照单独落（失败也要留输入，微调数据源不能只有成功样本）
        resumeScoreMapper.update(null, new LambdaUpdateWrapper<ResumeScore>()
                .eq(ResumeScore::getId, rowId)
                .set(ResumeScore::getInputJson, JSON.toJSONString(req)));

        log.info("开始打分: candidate={}, version={}, type={}, requestId={}",
                candidateId, resumeVersionId, scoreType, requestId);
        try {
            AiScoreResultVO.DataBody data = aiServiceClient.score(req);
            resumeScoreMapper.update(null, new LambdaUpdateWrapper<ResumeScore>()
                    .eq(ResumeScore::getId, rowId)
                    .set(ResumeScore::getStatus, "success")
                    .set(ResumeScore::getScore, data.getScore())
                    .set(ResumeScore::getSummary, cut(data.getSummary(), 2048))
                    .set(ResumeScore::getDetailsJson, JSON.toJSONString(data))
                    .set(ResumeScore::getModel, data.getModel())
                    .set(ResumeScore::getFailReason, null));
            log.info("打分成功: candidate={}, version={}, type={}, score={}, recommendation={}",
                    candidateId, resumeVersionId, scoreType, data.getScore(), data.getRecommendation());
        } catch (Exception e) {
            String reason = cut(e.getMessage(), 512);
            resumeScoreMapper.update(null, new LambdaUpdateWrapper<ResumeScore>()
                    .eq(ResumeScore::getId, rowId)
                    .set(ResumeScore::getStatus, "failed")
                    .set(ResumeScore::getScore, null)
                    .set(ResumeScore::getFailReason, reason));
            log.warn("打分失败: candidate={}, version={}, reason={}", candidateId, resumeVersionId, reason);
        }
    }

    /** UPSERT：同一 (resume_version_id, request_key) 只有一行，重打覆盖旧结果 */
    private Long upsertPending(Long candidateId, Long resumeVersionId, Long applicationId,
                                Long requestId, String requestKey, String scoreType) {
        List<ResumeScore> hits = resumeScoreMapper.selectList(
                new LambdaQueryWrapper<ResumeScore>()
                        .eq(ResumeScore::getResumeVersionId, resumeVersionId)
                        .eq(ResumeScore::getRequestKey, requestKey)
                        .orderByAsc(ResumeScore::getId)
                        .last("LIMIT 1"));
        if (hits.isEmpty()) {
            ResumeScore row = new ResumeScore();
            row.setCandidateId(candidateId);
            row.setResumeVersionId(resumeVersionId);
            row.setRequestKey(requestKey);
            // score_type NOT NULL 且无默认值，insert 必须带全（applicationId/requestId 一并带上，与 update 分支对称）
            row.setApplicationId(applicationId);
            row.setRequestId(requestId);
            row.setScoreType(scoreType);
            row.setStatus("pending");
            resumeScoreMapper.insert(row);
            return row.getId();
        }
        Long rowId = hits.get(0).getId();
        // updateById 默认忽略 null 字段，清旧值必须用 UpdateWrapper 显式 set null
        resumeScoreMapper.update(null, new LambdaUpdateWrapper<ResumeScore>()
                .eq(ResumeScore::getId, rowId)
                .set(ResumeScore::getApplicationId, applicationId)
                .set(ResumeScore::getRequestId, requestId)
                .set(ResumeScore::getScoreType, scoreType)
                .set(ResumeScore::getStatus, "pending")
                .set(ResumeScore::getScore, null)
                .set(ResumeScore::getSummary, null)
                .set(ResumeScore::getDetailsJson, null)
                .set(ResumeScore::getModel, null)
                .set(ResumeScore::getFailReason, null)
                .set(ResumeScore::getInputJson, null));
        return rowId;
    }

    private CandidateApplication latestApplication(Long candidateId) {
        List<CandidateApplication> hits = applicationMapper.selectList(
                new LambdaQueryWrapper<CandidateApplication>()
                        .eq(CandidateApplication::getCandidateId, candidateId)
                        .orderByDesc(CandidateApplication::getId)
                        .last("LIMIT 1"));
        return hits.isEmpty() ? null : hits.get(0);
    }

    // ==================================================================
    // 4) 打分输入组装
    // ==================================================================

    private AiScoreRequestDTO buildRequest(Candidate candidate, ResumeVersion version, HrRequest request) {
        AiScoreRequestDTO req = new AiScoreRequestDTO();
        req.setResumeId(version.getId());
        req.setCandidateId(candidate.getId());
        req.setResumeText(buildResumeText(version.getFieldsJson()));
        req.setCandidateSummary(buildCandidateSummary(candidate));
        if (request != null) {
            AiScoreRequestDTO.JobInfo job = new AiScoreRequestDTO.JobInfo();
            job.setRequestId(request.getId());
            job.setTitle(request.getTitle());
            job.setJobDescription(request.getJobDescription());
            job.setJobRequirement(request.getJobRequirement());
            job.setSalaryMin(request.getSalaryMin());
            job.setSalaryMax(request.getSalaryMax());
            job.setEducation(request.getEducation());
            job.setExperienceYears(request.getExperienceYears());
            job.setLocation(request.getLocation());
            req.setJob(job);
        }
        return req;
    }

    /** 候选人摘要（candidate 表无 PII，只有 hash，天然安全） */
    private Map<String, Object> buildCandidateSummary(Candidate c) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("name", c.getName());
        summary.put("currentTitle", c.getCurrentTitle());
        summary.put("workYear", c.getWorkYear());
        summary.put("education", c.getEducation());
        summary.put("school", c.getSchool());
        summary.put("major", c.getMajor());
        summary.put("city", c.getCity());
        summary.put("expectSalary", c.getExpectSalary());
        summary.put("age", c.getAge());
        summary.put("gender", genderText(c.getGender()));
        summary.values().removeIf(v -> v == null || !StringUtils.hasText(String.valueOf(v)));
        return summary;
    }

    /**
     * 把 fields_json 展平成「key.path: value」行文本。
     *
     * <p>fields_json 是平台归一后的结构化字段（含 workExperienceList 等嵌套结构），
     * 展平后 LLM 可读性远好于塞原始 JSON；上限截断防脏数据撑爆 prompt。</p>
     */
    private String buildResumeText(String fieldsJson) {
        if (!StringUtils.hasText(fieldsJson)) {
            return "（简历字段为空）";
        }
        StringBuilder sb = new StringBuilder();
        Object parsed = JSON.parse(fieldsJson);
        flatten(parsed, "", sb, 0);
        String text = sb.toString().trim();
        if (text.isEmpty()) {
            return "（简历字段为空）";
        }
        return text.length() > MAX_RESUME_TEXT_CHARS ? text.substring(0, MAX_RESUME_TEXT_CHARS) : text;
    }

    @SuppressWarnings("unchecked")
    private void flatten(Object value, String path, StringBuilder sb, int depth) {
        if (value == null || depth > 6) {
            return;
        }
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<String, Object> e : ((Map<String, Object>) map).entrySet()) {
                String key = path.isEmpty() ? e.getKey() : path + "." + e.getKey();
                flatten(e.getValue(), key, sb, depth + 1);
            }
        } else if (value instanceof List<?> list) {
            boolean allScalar = list.stream().allMatch(v -> !(v instanceof Map) && !(v instanceof List));
            if (allScalar) {
                String joined = list.stream().map(String::valueOf).filter(s -> !s.isBlank())
                        .collect(Collectors.joining(", "));
                if (!joined.isEmpty()) {
                    sb.append(path).append(": ").append(joined).append('\n');
                }
            } else {
                for (int i = 0; i < list.size(); i++) {
                    flatten(list.get(i), path + "[" + i + "]", sb, depth + 1);
                }
            }
        } else {
            String s = String.valueOf(value).trim();
            if (!s.isEmpty()) {
                sb.append(path).append(": ").append(s).append('\n');
            }
        }
    }

    private String genderText(Integer gender) {
        if (gender == null) {
            return null;
        }
        return switch (gender) {
            case 1 -> "男";
            case 2 -> "女";
            default -> null;
        };
    }

    // ==================================================================
    // 5) VO 转换
    // ==================================================================

    private ResumeScoreVO toVO(ResumeScore r, Map<Long, HrRequest> requests) {
        List<ResumeScoreVO.Dimension> dimensions = List.of();
        List<String> highlights = List.of();
        List<String> risks = List.of();
        String recommendation = null;
        if (StringUtils.hasText(r.getDetailsJson())) {
            try {
                JSONObject d = JSON.parseObject(r.getDetailsJson());
                recommendation = d.getString("recommendation");
                JSONArray dimArr = d.getJSONArray("dimensions");
                if (dimArr != null) {
                    dimensions = dimArr.stream()
                            .map(x -> (JSONObject) x)
                            .map(x -> ResumeScoreVO.Dimension.builder()
                                    .name(x.getString("name"))
                                    .score(x.getInteger("score"))
                                    .comment(x.getString("comment"))
                                    .build())
                            .toList();
                }
                JSONArray hl = d.getJSONArray("highlights");
                if (hl != null) {
                    highlights = hl.toList(String.class);
                }
                JSONArray rk = d.getJSONArray("risks");
                if (rk != null) {
                    risks = rk.toList(String.class);
                }
            } catch (Exception e) {
                log.warn("打分结果解析失败（原样展示其余字段）: scoreId={}", r.getId(), e);
            }
        }
        HrRequest request = r.getRequestId() != null ? requests.get(r.getRequestId()) : null;
        return ResumeScoreVO.builder()
                .id(String.valueOf(r.getId()))
                .candidateId(String.valueOf(r.getCandidateId()))
                .resumeVersionId(String.valueOf(r.getResumeVersionId()))
                .scoreType(r.getScoreType())
                .status(r.getStatus())
                .score(r.getScore())
                .summary(r.getSummary())
                .recommendation(recommendation)
                .requestId(r.getRequestId() != null ? String.valueOf(r.getRequestId()) : null)
                .requestTitle(request != null ? request.getTitle() : null)
                .dimensions(dimensions)
                .highlights(highlights)
                .risks(risks)
                .model(r.getModel())
                .failReason(r.getFailReason())
                .createdAt(r.getCreatedAt())
                .updatedAt(r.getUpdatedAt())
                .build();
    }

    private String cut(String s, int max) {
        if (s == null) {
            return null;
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
