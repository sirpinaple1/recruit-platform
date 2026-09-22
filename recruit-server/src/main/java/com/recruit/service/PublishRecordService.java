package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.recruit.common.CollectRules;
import com.recruit.common.MyException;
import com.recruit.dto.RecordReportDTO;
import com.recruit.entity.Channel;
import com.recruit.entity.HrRequest;
import com.recruit.entity.PublishDraft;
import com.recruit.entity.PublishRecord;
import com.recruit.mapper.ChannelMapper;
import com.recruit.mapper.HrRequestMapper;
import com.recruit.mapper.PublishDraftMapper;
import com.recruit.mapper.PublishRecordMapper;
import com.recruit.vo.ExtDraftVO;
import com.recruit.vo.PublishRecordVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 发布台账（见设计文档 §5.4）：
 * - approve 渲染草稿时同步建 pending 台账（一对一，draft_id 唯一）；
 * - 需求关闭 / 草稿重渲染时未回填台账置 failed（行保留审计，result_note 记原因）；
 * - 扩展端回填终结为 published/failed，operated_by 取扩展 token 关联用户；
 * - 回填成功同时将草稿置 consumed（一条草稿对应一次发布动作）。
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class PublishRecordService {

    private static final List<String> RECORD_STATUSES = List.of("pending", "published", "failed");

    private final PublishRecordMapper publishRecordMapper;
    private final PublishDraftMapper publishDraftMapper;
    private final ChannelMapper channelMapper;
    private final HrRequestMapper hrRequestMapper;
    /** 台账绑定平台岗位后需级联刷新投递的派生字段（request_id） */
    private final CandidateApplicationService candidateApplicationService;

    /** 渲染草稿时同步建 pending 台账（与 PublishDraftService.renderForRequest 同事务） */
    public void createPendingFor(PublishDraft draft) {
        PublishRecord record = new PublishRecord();
        record.setDraftId(draft.getId());
        record.setRequestId(draft.getRequestId());
        record.setChannelId(draft.getChannelId());
        record.setStatus("pending");
        publishRecordMapper.insert(record);
    }

    /** 需求关闭 / 草稿重渲染：该需求未回填（pending）台账置 failed，行保留审计 */
    public void failPendingByRequest(Long requestId, String note) {
        publishRecordMapper.update(null, new LambdaUpdateWrapper<PublishRecord>()
                .eq(PublishRecord::getRequestId, requestId)
                .eq(PublishRecord::getStatus, "pending")
                .set(PublishRecord::getStatus, "failed")
                .set(PublishRecord::getResultNote, note));
    }

    /** 扩展端：pending 草稿列表（含 fields_json、渠道元数据与 recordId，一期不按用户隔离） */
    public List<ExtDraftVO> listPendingForExt() {
        List<PublishDraft> drafts = publishDraftMapper.selectList(new LambdaQueryWrapper<PublishDraft>()
                .eq(PublishDraft::getStatus, "pending")
                .orderByDesc(PublishDraft::getId));
        if (drafts.isEmpty()) {
            return List.of();
        }
        Map<Long, PublishRecord> recordByDraft = publishRecordMapper.selectList(
                        new LambdaQueryWrapper<PublishRecord>()
                                .in(PublishRecord::getDraftId, drafts.stream().map(PublishDraft::getId).toList()))
                .stream().collect(Collectors.toMap(PublishRecord::getDraftId, Function.identity()));
        Map<Long, Channel> channelById = channelMapper.selectList(null).stream()
                .collect(Collectors.toMap(Channel::getId, Function.identity()));
        Map<Long, HrRequest> requestById = hrRequestMapper.selectBatchIds(
                        drafts.stream().map(PublishDraft::getRequestId).distinct().toList())
                .stream().collect(Collectors.toMap(HrRequest::getId, Function.identity()));
        return drafts.stream()
                .map(d -> ExtDraftVO.from(d, recordByDraft.get(d.getId()),
                        requestById.get(d.getRequestId()), channelById.get(d.getChannelId())))
                .toList();
    }

    /** 扩展端回填：仅 pending 台账可回填（防重复终结）；published 写 published_at；草稿置 consumed */
    @Transactional(rollbackFor = Exception.class)
    public PublishRecordVO report(Long recordId, RecordReportDTO dto, Long extUserId) {
        PublishRecord record = publishRecordMapper.selectById(recordId);
        if (record == null) {
            throw new MyException(404, "台账不存在");
        }
        if (!"pending".equals(record.getStatus())) {
            throw new MyException(400, "该台账已回填（当前状态：" + record.getStatus() + "），不允许重复回填");
        }
        LocalDateTime now = LocalDateTime.now(ZoneOffset.UTC);
        LambdaUpdateWrapper<PublishRecord> wrapper = new LambdaUpdateWrapper<PublishRecord>()
                .eq(PublishRecord::getId, recordId)
                .eq(PublishRecord::getStatus, "pending")
                .set(PublishRecord::getStatus, dto.getStatus())
                .set(PublishRecord::getOperatedBy, extUserId)
                .set(PublishRecord::getAccountLabel, StringUtils.hasText(dto.getAccountLabel()) ? dto.getAccountLabel().trim() : null)
                .set(PublishRecord::getPublishedUrl, StringUtils.hasText(dto.getPublishedUrl()) ? dto.getPublishedUrl().trim() : null)
                .set(PublishRecord::getResultNote, StringUtils.hasText(dto.getResultNote()) ? dto.getResultNote().trim() : null);
        if ("published".equals(dto.getStatus())) {
            wrapper.set(PublishRecord::getPublishedAt, now);
        }

        // ---------- 平台岗位映射（路径 A：自动捕获） ----------
        // 写入门槛两条，缺一不可：
        //   ① status 必须是 published —— **发布失败不存在新的平台岗位**。若允许 failed 也写，
        //      扩展在失败页上误看到的某个岗位 ID 会被记成映射，而且会占住唯一键，
        //      把后续真正正确的绑定挡在 409 外面（这类"占位式错误"比没有映射更难排查）。
        //   ② 本台账尚未绑定过岗位（bind_source IS NULL）—— 已绑定就不动，无论那是
        //      人工绑定（HR 纠正过，绝不能被自动改回）还是更早的自动绑定。
        String platformJobId = trimToNull(dto.getPlatformJobId());
        boolean jobMappingWritten = false;
        if ("published".equals(dto.getStatus()) && platformJobId != null
                && record.getPlatformJobBindSource() == null) {
            // 先挡住「绑了也永远解析不到」的静默失效（见 requireCapturableChannel）
            requireCapturableChannel(record.getChannelId());
            Long channelId = record.getChannelId();
            // 预检冲突：一个平台岗位只能属于一个需求单（最终防线是 UNIQUE 索引，这里先给出可读提示）
            PublishRecord owner = findRecordByChannelJob(channelId, platformJobId);
            if (owner != null && !owner.getId().equals(recordId)) {
                throw new MyException(409, "平台岗位 " + platformJobId + " 已绑定到台账 " + owner.getId()
                        + "（需求 " + owner.getRequestId() + "）。一个平台岗位只能对应一个需求单，"
                        + "请先在该台账上解除绑定");
            }
            wrapper.set(PublishRecord::getPlatformJobId, platformJobId)
                    .set(PublishRecord::getPlatformJobBindSource, "auto");
            jobMappingWritten = true;
        }

        try {
            publishRecordMapper.update(null, wrapper);
        } catch (DuplicateKeyException e) {
            // 并发窗口：预检通过但另一请求同时绑定了同一岗位。
            // 唯一键 uk_channel_platform_job 在这里兜住 —— 抛 409 而不是让它变成 500，
            // 也绝不允许「静默抢走」别人的岗位。
            throw new MyException(409, "平台岗位 " + platformJobId + " 已被并发绑定到其它台账，请刷新后重试");
        }
        // 回填即消费草稿（一条草稿对应一次发布动作）
        publishDraftMapper.update(null, new LambdaUpdateWrapper<PublishDraft>()
                .eq(PublishDraft::getId, record.getDraftId())
                .eq(PublishDraft::getStatus, "pending")
                .set(PublishDraft::getStatus, "consumed"));
        log.info("台账回填：record={}, status={}, operator={}", recordId, dto.getStatus(), extUserId);

        // 映射刚落 → 立刻级联：把该平台岗位下已落库、但当时还解析不到 request_id 的投递补上。
        // 放在同一事务里，保证「映射可见」与「投递已归类」不会出现中间态。
        if (jobMappingWritten) {
            int affected = candidateApplicationService.recomputeByPlatformJob(record.getChannelId(), platformJobId);
            log.info("台账 {} 绑定平台岗位 {} → 级联刷新投递 {} 行", recordId, platformJobId, affected);
        }
        return getDetail(recordId);
    }

    /**
     * 人工绑定 / 更正 / 解除平台岗位映射（路径 B，见设计文档 candidate-position-linking.md）。
     *
     * <p>与路径 A（{@link #report} 里的自动捕获）的关系：</p>
     * <table border="1">
     *   <tr><th></th><th>A 自动捕获</th><th>B 人工绑定（本方法）</th></tr>
     *   <tr><td>写入门槛</td><td>仅 {@code bind_source IS NULL}（不覆盖人工）</td>
     *       <td>可覆盖<b>任何</b>状态，包括 auto 与既有 manual</td></tr>
     *   <tr><td>触发时机</td><td>只能随发布回填一次</td><td>随时，可反复更正</td></tr>
     * </table>
     * <p>这条「自动不覆盖人工、人工可覆盖一切」的规则就是 {@code platform_job_bind_source}
     * 存在的全部理由：没有它，HR 手工纠正过的绑定会在下一次自动上报时被静默改回。</p>
     *
     * <h3>为什么要求台账已是 published</h3>
     * <p>只有「确实发布出去了」的台账才对应平台上的一个真实岗位。若允许 pending 也绑定，
     * 「是否已发布」就有了两个真源（status 与 platform_job_id），二者迟早不一致。
     * 拦截提示里给了出口：先标记已发布（扩展面板）再回来绑定。</p>
     *
     * <h3>级联是双向的</h3>
     * <p>改绑后要刷<b>两个</b>平台岗位的投递：</p>
     * <ul>
     *   <li>新岗位 → 解析到本台账的需求单；</li>
     *   <li>旧岗位 → 已无台账持有它，解析结果变 NULL，其投递回落到「未归类」（可见状态，
     *       而不是留着旧需求单不动 —— 那会造成同一岗位的投递归属分裂）。</li>
     * </ul>
     *
     * @param platformJobId 平台岗位 ID；传空表示解除绑定
     * @return 更新后的台账视图
     */
    @Transactional(rollbackFor = Exception.class)
    public PublishRecordVO bindPlatformJob(Long recordId, String platformJobId, Long operatorId) {
        PublishRecord record = publishRecordMapper.selectById(recordId);
        if (record == null) {
            throw new MyException(404, "台账不存在");
        }
        if (!"published".equals(record.getStatus())) {
            throw new MyException(400, "只有已发布的台账才能关联平台岗位（当前状态：" + record.getStatus()
                    + "）。若实际已发布但系统没检测到成功信号，请先在扩展面板把该台账标记为已发布");
        }

        Long channelId = record.getChannelId();
        String oldJobId = trimToNull(record.getPlatformJobId());
        String newJobId = trimToNull(platformJobId);

        // 幂等：已是同一人工绑定则直接返回，不制造无意义的级联与审计噪声。
        // 注意「auto → manual 但值没变」**不**走这条路 —— 那是 HR 在确认自动值，
        // 需要把来源升格为 manual（表示"人看过了"），后续自动流程不再碰它。
        if (java.util.Objects.equals(oldJobId, newJobId) && "manual".equals(record.getPlatformJobBindSource())) {
            return getDetail(recordId);
        }

        if (newJobId != null) {
            // 同上：非采集渠道上的映射永远不会生效，当场拒绝而不是留个假象
            requireCapturableChannel(channelId);
            PublishRecord owner = findRecordByChannelJob(channelId, newJobId);
            if (owner != null && !owner.getId().equals(recordId)) {
                throw new MyException(409, "平台岗位 " + newJobId + " 已绑定到台账 " + owner.getId()
                        + "（需求 " + owner.getRequestId() + "）。一个平台岗位只能对应一个需求单，"
                        + "请先到该台账解除绑定");
            }
        }

        LambdaUpdateWrapper<PublishRecord> wrapper = new LambdaUpdateWrapper<PublishRecord>()
                .eq(PublishRecord::getId, recordId)
                .set(PublishRecord::getPlatformJobId, newJobId)
                // 解除绑定时三列一起清，不留"来源=manual 但没有值"的半状态
                .set(PublishRecord::getPlatformJobBindSource, newJobId == null ? null : "manual")
                .set(PublishRecord::getPlatformJobBoundBy, newJobId == null ? null : operatorId);
        try {
            publishRecordMapper.update(null, wrapper);
        } catch (DuplicateKeyException e) {
            throw new MyException(409, "平台岗位 " + newJobId + " 已被并发绑定到其它台账，请刷新后重试");
        }

        int affected = 0;
        if (oldJobId != null && !oldJobId.equals(newJobId)) {
            affected += candidateApplicationService.recomputeByPlatformJob(channelId, oldJobId);
        }
        if (newJobId != null) {
            affected += candidateApplicationService.recomputeByPlatformJob(channelId, newJobId);
        }
        log.info("人工绑定平台岗位：record={}, {} -> {}, operator={}, 级联刷新投递 {} 行",
                recordId, oldJobId, newJobId, operatorId, affected);
        return getDetail(recordId);
    }

    /**
     * 按渠道 + 平台岗位查占用台账（冲突预检）。
     * 取 list + LIMIT 1 而非 selectOne：表上有唯一键，正常最多一行，
     * 但唯一键万一被放宽时 selectOne 会因 TooManyResults 把回填整体打成 500。
     */
    private PublishRecord findRecordByChannelJob(Long channelId, String platformJobId) {
        if (channelId == null || !StringUtils.hasText(platformJobId)) {
            return null;
        }
        List<PublishRecord> hits = publishRecordMapper.selectList(new LambdaQueryWrapper<PublishRecord>()
                .eq(PublishRecord::getChannelId, channelId)
                .eq(PublishRecord::getPlatformJobId, platformJobId.trim())
                .orderByAsc(PublishRecord::getId)
                .last("LIMIT 1"));
        return hits.isEmpty() ? null : hits.get(0);
    }

    private String trimToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    /**
     * 校验「该台账所属渠道具备采集能力」，不具备则拒绝写入岗位映射。
     *
     * <p>不做这一步的后果是<b>静默失效</b>：投递归属按
     * {@code (platform, platform_job_id)} 解析，而 platform 只能是采集平台
     * （{@code CollectRules.CAPTURABLE_PLATFORMS}）；台账记录的映射键却是
     * {@code (channel_id → channel.code, platform_job_id)}。两者不等时，
     * 映射<em>写入成功、台账上显示「已关联」</em>，却永远解析不到任何候选人 ——
     * 功能看着好了、数据却一直错。</p>
     *
     * <p>实测来源：2026-09-22 端到端回归里，把一条 mock_demo 台账绑上岗位 ID 后，
     * 采集回来的投递 {@code request_id} 一直是 NULL。行为本身是对的（键不匹配），
     * 但「写入成功」这个反馈是误导性的，故在此拦下。</p>
     */
    private void requireCapturableChannel(Long channelId) {
        Channel channel = channelId == null ? null : channelMapper.selectById(channelId);
        String code = channel == null ? null : channel.getCode();
        if (code != null && CollectRules.CAPTURABLE_PLATFORMS.contains(code)) {
            return;
        }
        throw new MyException(400, "该台账所属渠道「" + (code == null ? "未知" : code)
                + "」不是采集渠道，绑定平台岗位不会生效：候选人投递只会从 "
                + String.join("/", CollectRules.CAPTURABLE_PLATFORMS)
                + " 上报，岗位 ID 将永远解析不到任何候选人。请确认该需求单发布到了正确的渠道");
    }

    /** 管理端台账分页查询（可按需求 / 渠道 / 状态筛选） */
    public IPage<PublishRecordVO> page(long page, long size, Long requestId, Long channelId, String status) {
        if (status != null && !RECORD_STATUSES.contains(status)) {
            throw new MyException(400, "台账状态必须是 pending/published/failed");
        }
        IPage<PublishRecord> result = publishRecordMapper.selectPage(new Page<>(page, size),
                new LambdaQueryWrapper<PublishRecord>()
                        .eq(requestId != null, PublishRecord::getRequestId, requestId)
                        .eq(channelId != null, PublishRecord::getChannelId, channelId)
                        .eq(status != null, PublishRecord::getStatus, status)
                        .orderByDesc(PublishRecord::getId));
        List<PublishRecordVO> vos = result.getRecords().stream().map(r -> {
            HrRequest request = r.getRequestId() == null ? null : hrRequestMapper.selectById(r.getRequestId());
            Channel channel = r.getChannelId() == null ? null : channelMapper.selectById(r.getChannelId());
            return PublishRecordVO.from(r, request, channel);
        }).toList();
        return new Page<PublishRecordVO>(result.getCurrent(), result.getSize(), result.getTotal()).setRecords(vos);
    }

    /** 单条详情（含渠道/需求冗余信息） */
    public PublishRecordVO getDetail(Long recordId) {
        PublishRecord record = publishRecordMapper.selectById(recordId);
        if (record == null) {
            throw new MyException(404, "台账不存在");
        }
        HrRequest request = record.getRequestId() == null ? null : hrRequestMapper.selectById(record.getRequestId());
        Channel channel = record.getChannelId() == null ? null : channelMapper.selectById(record.getChannelId());
        return PublishRecordVO.from(record, request, channel);
    }
}
