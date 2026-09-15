package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
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
        publishRecordMapper.update(null, wrapper);
        // 回填即消费草稿（一条草稿对应一次发布动作）
        publishDraftMapper.update(null, new LambdaUpdateWrapper<PublishDraft>()
                .eq(PublishDraft::getId, record.getDraftId())
                .eq(PublishDraft::getStatus, "pending")
                .set(PublishDraft::getStatus, "consumed"));
        log.info("台账回填：record={}, status={}, operator={}", recordId, dto.getStatus(), extUserId);
        return getDetail(recordId);
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
