package com.recruit.vo;

import com.recruit.entity.Channel;
import com.recruit.entity.HrRequest;
import com.recruit.entity.PublishRecord;
import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 发布台账列表项（含渠道/需求冗余信息，管理端台账页展示用）。
 */
@Data
@Builder
public class PublishRecordVO {

    /** 雪花 ID：超 JS 安全整数范围，用 String 传输防前端丢精度 */
    private String id;

    private String draftId;

    private String requestId;

    private String requestNo;

    private String requestTitle;

    private String channelId;

    private String channelName;

    /** pending/published/failed */
    private String status;

    private String accountLabel;

    private String publishedUrl;

    /**
     * 平台侧岗位 ID（BOSS jobId）—— 中台需求单与平台岗位的映射键。
     *
     * <p>null = 该次发布尚未建立映射（扩展没捕获到）。这正是人工绑定的入口条件，
     * 所以必须透出，否则 HR 无从知道「哪些发布还没关联岗位」。</p>
     */
    private String platformJobId;

    /**
     * 岗位 ID 来源：{@code auto} 扩展发布成功后自动捕获 / {@code manual} 中台人工绑定。
     *
     * <p>透出给中台是为了让 HR 一眼看出「这个关联是机器猜的还是人确认的」——
     * auto 值在后续批次里可被人工覆盖，manual 值不会被自动流程改动。</p>
     */
    private String platformJobBindSource;

    private String resultNote;

    private String operatedBy;

    private LocalDateTime publishedAt;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    public static PublishRecordVO from(PublishRecord r, HrRequest request, Channel channel) {
        return PublishRecordVO.builder()
                .id(r.getId() == null ? null : String.valueOf(r.getId()))
                .draftId(r.getDraftId() == null ? null : String.valueOf(r.getDraftId()))
                .requestId(r.getRequestId() == null ? null : String.valueOf(r.getRequestId()))
                .requestNo(request == null ? null : request.getRequestNo())
                .requestTitle(request == null ? null : request.getTitle())
                .channelId(r.getChannelId() == null ? null : String.valueOf(r.getChannelId()))
                .channelName(channel == null ? null : channel.getName())
                .status(r.getStatus())
                .accountLabel(r.getAccountLabel())
                .publishedUrl(r.getPublishedUrl())
                .platformJobId(r.getPlatformJobId())
                .platformJobBindSource(r.getPlatformJobBindSource())
                .resultNote(r.getResultNote())
                .operatedBy(r.getOperatedBy() == null ? null : String.valueOf(r.getOperatedBy()))
                .publishedAt(r.getPublishedAt())
                .createdAt(r.getCreatedAt())
                .updatedAt(r.getUpdatedAt())
                .build();
    }
}
