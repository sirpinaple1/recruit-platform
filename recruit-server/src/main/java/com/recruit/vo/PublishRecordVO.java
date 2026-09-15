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
                .resultNote(r.getResultNote())
                .operatedBy(r.getOperatedBy() == null ? null : String.valueOf(r.getOperatedBy()))
                .publishedAt(r.getPublishedAt())
                .createdAt(r.getCreatedAt())
                .updatedAt(r.getUpdatedAt())
                .build();
    }
}
