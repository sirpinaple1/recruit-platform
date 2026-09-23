package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.recruit.entity.CandidateApplication;
import com.recruit.entity.Channel;
import com.recruit.entity.HrRequest;
import com.recruit.entity.PublishRecord;
import com.recruit.mapper.CandidateApplicationMapper;
import com.recruit.mapper.ChannelMapper;
import com.recruit.mapper.HrRequestMapper;
import com.recruit.mapper.PublishRecordMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 候选人投递事实（candidate_application）的唯一写入与解析入口。
 *
 * <p>见 {@code docs/design/candidate-position-linking.md}。本类承担三件事：</p>
 * <ol>
 *   <li><b>落事实</b>：采集时把「某人对某平台岗位产生了投递」按三元组幂等落库；</li>
 *   <li><b>解映射</b>：把 (platform, platformJobId) 解析成 {@code hr_request.id}
 *       （经 {@code publish_record.platform_job_id}，不新建映射真源）；</li>
 *   <li><b>级联重算</b>：映射建立或变更后，批量刷新受影响投递的 {@code request_id}。</li>
 * </ol>
 *
 * <h3>一致性设计（为什么这样是对的）</h3>
 * <table border="1">
 *   <tr><th>不变式</th><th>由什么保证</th></tr>
 *   <tr><td>一个平台岗位只属于一个需求单</td>
 *       <td>{@code publish_record} 的 UNIQUE (channel_id, platform_job_id)</td></tr>
 *   <tr><td>同一人对同一岗位只有一条投递</td>
 *       <td>本表的 UNIQUE (platform, candidate_id, platform_job_id)</td></tr>
 *   <tr><td>投递的 request_id 与映射永远一致</td>
 *       <td><b>request_id 是派生值</b>：改映射时级联重算，而不是让历史行留旧值</td></tr>
 *   <tr><td>映射未知时不瞎猜近似岗</td>
 *       <td>精确 ID 解析不到时，先走「同名岗位兜底」（见 {@link #resolveRequestIdByName}，
 *           排除法 + 唯一才认）；仍解析不到才写 NULL —— 模糊/多义匹配永远不做</td></tr>
 * </table>
 *
 * <p><b>为什么级联重算是 UPDATE 而不是删了重建</b>：投递的「事实」部分是
 * (candidate, platformJobId, appliedAt)，这三者不随映射变化；只有 requestId 派生。
 * 重算是幂等 UPDATE，可安全重复执行；删重建会改掉 id 并丢失 appliedAt 语义。</p>
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class CandidateApplicationService {

    private final CandidateApplicationMapper applicationMapper;
    private final ChannelMapper channelMapper;
    private final PublishRecordMapper publishRecordMapper;
    private final HrRequestMapper hrRequestMapper;

    // ==================================================================
    // 1) 落事实（采集侧调用）
    // ==================================================================

    /**
     * 由一次采集落一条投递事实（幂等）。
     *
     * <p><b>幂等语义</b>：三元组 (platform, candidateId, platformJobId) 已存在时<b>不新建</b>，
     * 也不能改写 {@code appliedAt}（那是首次观测时刻）。但若该行的 {@code requestId}
     * 仍为 NULL，会顺手再解析一次——这样「先采集、后建映射」的顺序自然自愈，
     * 不依赖任何批处理任务。</p>
     *
     * @param platformJobId 平台岗位 ID；<b>为空时直接返回 null（不落半行）</b>
     * @return 新建的行；未新建（已存在或岗位 ID 为空）时返回 null
     */
    @Transactional(rollbackFor = Exception.class)
    public CandidateApplication recordFromCollect(Long candidateId, String platform,
                                                  String platformJobId, String platformJobHint,
                                                  String sourceChannel, Long resumeVersionId,
                                                  LocalDateTime appliedAt) {
        if (candidateId == null || !StringUtils.hasText(platform) || !StringUtils.hasText(platformJobId)) {
            // 没有岗位 ID 就没有「投递到哪个岗」这个事实 —— 不落行，留给人工归类。
            // 刻意不建「request_id 为空的占位行」：那样「哪些人还没归类」就没法用
            // 「本表无行」来判定，查询侧要额外区分两种空。
            return null;
        }
        String jobId = platformJobId.trim();

        // 同 CollectService 的防御习惯：取 list + LIMIT 1 而非 selectOne。
        // 表上有唯一键，正常不可能多行；但万一唯一键被放宽，
        // selectOne 会因 TooManyResults 让**采集整体失败**，而 LIMIT 1 只是安静取第一条。
        List<CandidateApplication> hits = applicationMapper.selectList(
                new LambdaQueryWrapper<CandidateApplication>()
                        .eq(CandidateApplication::getPlatform, platform)
                        .eq(CandidateApplication::getCandidateId, candidateId)
                        .eq(CandidateApplication::getPlatformJobId, jobId)
                        .orderByAsc(CandidateApplication::getId)
                        .last("LIMIT 1"));

        if (!hits.isEmpty()) {
            CandidateApplication existing = hits.get(0);
            // 自愈：映射可能是「先采集、后绑定」才出现的
            if (existing.getRequestId() == null) {
                Long resolved = resolveRequestId(platform, jobId);
                if (resolved == null) {
                    resolved = resolveRequestIdByName(platformJobHint);
                }
                if (resolved != null) {
                    existing.setRequestId(resolved);
                    applicationMapper.updateById(existing);
                    log.info("投递补映射：application={}, job={}, request={}",
                            existing.getId(), jobId, resolved);
                }
            }
            return null;
        }

        CandidateApplication application = new CandidateApplication();
        application.setCandidateId(candidateId);
        application.setPlatform(platform);
        application.setPlatformJobId(jobId);
        application.setPlatformJobHint(cut(platformJobHint, 128));
        Long requestId = resolveRequestId(platform, jobId);
        if (requestId == null) {
            requestId = resolveRequestIdByName(platformJobHint);
        }
        application.setRequestId(requestId);
        application.setSourceChannel(cut(sourceChannel, 32));
        application.setFirstResumeVersionId(resumeVersionId);
        application.setAppliedAt(appliedAt != null ? appliedAt : LocalDateTime.now(ZoneOffset.UTC));
        applicationMapper.insert(application);
        log.info("投递落库：candidate={}, platform={}, job={}, request={}",
                candidateId, platform, jobId, application.getRequestId());
        return application;
    }

    // ==================================================================
    // 2) 解映射（唯一真源：publish_record）
    // ==================================================================

    /**
     * 把 (platform, platformJobId) 解析成需求单 ID。
     *
     * <p>不存在的映射返回 {@code null}——调用方据此把 {@code request_id} 写成 NULL，
     * <b>而不是</b>用标题/薪资之类去猜一个近似岗。猜错会把候选人归到错误的职位下，
     * 而错误归类比未归类危险得多（未归类看得见，错分类看不见）。</p>
     */
    public Long resolveRequestId(String platform, String platformJobId) {
        if (!StringUtils.hasText(platform) || !StringUtils.hasText(platformJobId)) {
            return null;
        }
        Long channelId = channelIdOf(platform);
        if (channelId == null) {
            return null;
        }
        return resolveRequestIdByChannel(channelId, platformJobId.trim());
    }

    /** 同上，但直接给 channel_id（发布侧本来就有，省一次 code→id 查询） */
    public Long resolveRequestIdByChannel(Long channelId, String platformJobId) {
        if (channelId == null || !StringUtils.hasText(platformJobId)) {
            return null;
        }
        List<PublishRecord> hits = publishRecordMapper.selectList(
                new LambdaQueryWrapper<PublishRecord>()
                        .eq(PublishRecord::getChannelId, channelId)
                        .eq(PublishRecord::getPlatformJobId, platformJobId.trim())
                        .orderByAsc(PublishRecord::getId)
                        .last("LIMIT 1"));
        return hits.isEmpty() ? null : hits.get(0).getRequestId();
    }

    /**
     * 同名岗位兜底解析（用户决策 2026-09-23：获取到的平台岗位与系统同名职位一一对应）。
     *
     * <p>背景：岗位经中台发布但发布成功信号未被哨兵捕获（或人工在 BOSS 直接发布）时，
     * {@code publish_record.platform_job_id} 没有落值，精确 ID 解析永远为 NULL ——
     * 投递长期「未归类」。此时退而求其次：从 {@code platform_job_hint}
     * （「9月23日 沟通的职位-Java初级工程师」）提取岗位名，与 {@code hr_request.title}
     * <b>精确</b>匹配。</p>
     *
     * <p><b>歧义规则（排除法 + 唯一才认）</b>：</p>
     * <ol>
     *   <li>仅匹配 {@code open} 状态的需求单；</li>
     *   <li>排除已有 {@code platform_job_id} 发布映射的同名需求单 ——
     *       它们对应的平台岗位是另一个 jobId（否则精确解析已命中），本次解析不到的
     *       jobId 不是它们；</li>
     *   <li>过滤后<b>必须恰好一条</b>才认；零条或多条都返回 null（不猜）。</li>
     * </ol>
     *
     * <p>兜底值可被真实映射纠正：后续发布台账补绑 {@code platform_job_id} 时，
     * {@link #recomputeByPlatformJob} 会按权威映射级联覆盖。</p>
     */
    public Long resolveRequestIdByName(String platformJobHint) {
        String jobName = jobNameFromHint(platformJobHint);
        if (!StringUtils.hasText(jobName)) {
            return null;
        }
        List<HrRequest> sameTitle = hrRequestMapper.selectList(
                new LambdaQueryWrapper<HrRequest>()
                        .eq(HrRequest::getTitle, jobName)
                        .eq(HrRequest::getStatus, "open")
                        .orderByDesc(HrRequest::getId));
        if (sameTitle.isEmpty()) {
            return null;
        }
        List<Long> requestIds = sameTitle.stream().map(HrRequest::getId).toList();
        Set<Long> boundRequestIds = publishRecordMapper.selectList(
                        new LambdaQueryWrapper<PublishRecord>()
                                .in(PublishRecord::getRequestId, requestIds)
                                .isNotNull(PublishRecord::getPlatformJobId))
                .stream().map(PublishRecord::getRequestId).collect(Collectors.toSet());
        List<HrRequest> unbound = sameTitle.stream()
                .filter(r -> !boundRequestIds.contains(r.getId())).toList();
        if (unbound.size() != 1) {
            log.info("同名岗位兜底放弃：岗位名={}，同名 open={} 条，排除已绑定后剩 {} 条（非唯一，不猜）",
                    jobName, sameTitle.size(), unbound.size());
            return null;
        }
        log.info("同名岗位兜底命中：岗位名={} → request={}（platform_job_id 映射未建立，按名称一一对应）",
                jobName, unbound.get(0).getId());
        return unbound.get(0).getId();
    }

    /**
     * 从沟通列表 hint 原文提取岗位名；格式漂移时返回 null（宁可不兜底）。
     *
     * <p>提取规则（BOSS 沟通列表原文）：取「沟通的职位-」分隔符之后的部分，
     * 「9月23日 沟通的职位-Java初级工程师」→「Java初级工程师」。不锚定日期前缀，
     * 因为真机取证 hint 可能带平台岗位 ID 前缀
     * （「600fe3fb… · 9月23日 沟通的职位-Java初级工程师」）。</p>
     */
    private String jobNameFromHint(String hint) {
        if (!StringUtils.hasText(hint)) {
            return null;
        }
        String name = hint.trim();
        int idx = name.indexOf("沟通的职位-");
        if (idx < 0) {
            return null;
        }
        return name.substring(idx + "沟通的职位-".length()).trim();
    }

    // ==================================================================
    // 3) 级联重算（映射建立 / 变更 / 解除后调用）
    // ==================================================================

    /**
     * 按渠道 + 平台岗位批量刷新投递的 {@code request_id}。
     *
     * <p><b>这是「改绑即级联」的实现</b>：映射一变，该平台岗位下所有投递的派生值
     * 一起变，全库口径不存在「老投递留在旧需求单」的窗口期。
     * 幂等——可重复调用，结果相同（这正是把 request_id 设计成派生值换来的好处）。</p>
     *
     * @return 受影响行数
     */
    @Transactional(rollbackFor = Exception.class)
    public int recomputeByPlatformJob(Long channelId, String platformJobId) {
        if (channelId == null || !StringUtils.hasText(platformJobId)) {
            return 0;
        }
        String platform = platformOf(channelId);
        if (!StringUtils.hasText(platform)) {
            // 渠道行不存在（不应发生）——不猜 code，直接不动作，避免误刷到别家渠道
            log.warn("级联重算跳过：channel_id={} 不存在或无常用 code", channelId);
            return 0;
        }
        Long requestId = resolveRequestIdByChannel(channelId, platformJobId);
        int rows = applicationMapper.update(null, new LambdaUpdateWrapper<CandidateApplication>()
                .eq(CandidateApplication::getPlatform, platform)
                .eq(CandidateApplication::getPlatformJobId, platformJobId.trim())
                .set(CandidateApplication::getRequestId, requestId));
        log.info("投递级联重算：platform={}, job={}, request={}, 影响 {} 行",
                platform, platformJobId, requestId, rows);
        return rows;
    }

    // ==================================================================
    // 4) 查询辅助（列表 / 详情 / 诊断）
    // ==================================================================

    /**
     * 批量取每个候选人「最近一次投递」——列表页展示用，避免 N+1。
     *
     * <p>口径与 {@link CandidateQueryService#countAttachments} 一致：一次 IN 查询后在内存归并。
     * 取最近一条（applied_at 降序，同刻取 id 大者）是因为列表只展示一个职位；
     * 全部投递在详情页展开。</p>
     */
    public Map<Long, CandidateApplication> latestByCandidate(List<Long> candidateIds) {
        if (candidateIds == null || candidateIds.isEmpty()) {
            return Map.of();
        }
        List<CandidateApplication> rows = applicationMapper.selectList(
                new LambdaQueryWrapper<CandidateApplication>()
                        .in(CandidateApplication::getCandidateId, candidateIds)
                        .orderByDesc(CandidateApplication::getAppliedAt)
                        .orderByDesc(CandidateApplication::getId));
        Map<Long, CandidateApplication> latest = new HashMap<>();
        for (CandidateApplication row : rows) {
            // 已按「新→旧」排序，首次遇到即该候选人的最新一条
            latest.putIfAbsent(row.getCandidateId(), row);
        }
        return latest;
    }

    /** 某候选人的全部投递（详情页展开） */
    public List<CandidateApplication> listByCandidate(Long candidateId) {
        return applicationMapper.selectList(new LambdaQueryWrapper<CandidateApplication>()
                .eq(CandidateApplication::getCandidateId, candidateId)
                .orderByDesc(CandidateApplication::getAppliedAt)
                .orderByDesc(CandidateApplication::getId));
    }

    /** 批量取投递（列表页统计「投了几个岗」用，避免 N+1） */
    public List<CandidateApplication> listByCandidateIds(List<Long> candidateIds) {
        if (candidateIds == null || candidateIds.isEmpty()) {
            return List.of();
        }
        return applicationMapper.selectList(new LambdaQueryWrapper<CandidateApplication>()
                .in(CandidateApplication::getCandidateId, candidateIds)
                .select(CandidateApplication::getCandidateId));
    }

    /**
     * 投过某需求单的候选人 ID 集合（「按职位看候选人」筛选的实现）。
     *
     * <p>只 select candidate_id 一列 —— 这个方法的用途只是拿 ID 集合去做下一跳查询，
     * 把整行拉回来纯属浪费。</p>
     *
     * <p>注意返回的是<b>去重后</b>的集合：一个人对同一岗位只可能有一条投递（唯一键约束），
     * 但同一需求单下可能有多条不同平台的投递，去重是必要的。</p>
     */
    public List<Long> candidateIdsByRequest(Long requestId) {
        if (requestId == null) {
            return List.of();
        }
        return applicationMapper.selectList(new LambdaQueryWrapper<CandidateApplication>()
                        .eq(CandidateApplication::getRequestId, requestId)
                        .select(CandidateApplication::getCandidateId))
                .stream()
                .map(CandidateApplication::getCandidateId)
                .distinct()
                .toList();
    }

    /** 投递总数（诊断口径，与 unmappedCount 对比得出「归类完成度」） */
    public long total() {
        return applicationMapper.selectCount(null);
    }

    /**
     * 尚未归类到需求单的投递数（{@code request_id IS NULL}）。
     *
     * <p>这个数字是路径 B（人工绑定）的<b>唯一驱动指标</b>：它不为 0 就说明
     * 有平台岗位还没建立映射，需要 HR 到发布台账页绑定。做成方法而不是靠人肉 SQL，
     * 是为了中台能直接把它显示出来。</p>
     */
    public long unmappedCount() {
        return applicationMapper.selectCount(new LambdaQueryWrapper<CandidateApplication>()
                .isNull(CandidateApplication::getRequestId));
    }

    // ==================================================================
    // 内部
    // ==================================================================

    /** platform code → channel.id（channel.code 是唯一键，代价可忽略） */
    private Long channelIdOf(String platform) {
        List<Channel> hits = channelMapper.selectList(new LambdaQueryWrapper<Channel>()
                .eq(Channel::getCode, platform)
                .orderByAsc(Channel::getId)
                .last("LIMIT 1"));
        return hits.isEmpty() ? null : hits.get(0).getId();
    }

    /** channel.id → platform code */
    private String platformOf(Long channelId) {
        Channel channel = channelMapper.selectById(channelId);
        return channel == null ? null : channel.getCode();
    }

    private String cut(String s, int max) {
        if (s == null) {
            return null;
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
