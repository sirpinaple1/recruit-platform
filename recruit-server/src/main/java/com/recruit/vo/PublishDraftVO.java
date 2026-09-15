package com.recruit.vo;

import com.alibaba.fastjson2.JSONObject;
import com.recruit.entity.Channel;
import com.recruit.entity.PublishDraft;
import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 发布草稿列表项（含渠道元数据冗余，便于前端/扩展直接展示）
 */
@Data
@Builder
public class PublishDraftVO {

    /** 雪花 ID：超 JS 安全整数范围，用 String 传输防前端丢精度 */
    private String id;

    private String requestId;

    private String channelId;

    private String channelCode;

    private String channelName;

    /** 渠道发布页 URL 匹配模式（扩展注入判定用） */
    private String publishUrlPattern;

    /** 按渠道映射渲染好的字段值（输出为 JSON 对象而非转义字符串） */
    private JSONObject fieldsJson;

    /** 实例化深链 */
    private String deepLink;

    /** pending/consumed/cancelled */
    private String status;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    public static PublishDraftVO from(PublishDraft d, Channel channel) {
        return PublishDraftVO.builder()
                .id(d.getId() == null ? null : String.valueOf(d.getId()))
                .requestId(d.getRequestId() == null ? null : String.valueOf(d.getRequestId()))
                .channelId(d.getChannelId() == null ? null : String.valueOf(d.getChannelId()))
                .channelCode(channel == null ? null : channel.getCode())
                .channelName(channel == null ? null : channel.getName())
                .publishUrlPattern(channel == null ? null : channel.getPublishUrlPattern())
                .fieldsJson(d.getFieldsJson() == null ? null : JSONObject.parseObject(d.getFieldsJson()))
                .deepLink(d.getDeepLink())
                .status(d.getStatus())
                .createdAt(d.getCreatedAt())
                .updatedAt(d.getUpdatedAt())
                .build();
    }
}
