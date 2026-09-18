package com.recruit.vo;

import com.alibaba.fastjson2.JSONObject;
import com.recruit.entity.Channel;
import com.recruit.entity.HrRequest;
import com.recruit.entity.PublishDraft;
import com.recruit.entity.PublishRecord;
import lombok.Builder;
import lombok.Data;

/**
 * 扩展端草稿视图（/api/ext/drafts，见设计文档 §6.2）：
 * 含 fields_json、渠道元数据与 recordId（popup「标记已发布/失败」回填用）。
 */
@Data
@Builder
public class ExtDraftVO {

    private String draftId;

    /** 一对一台账 id，回填 POST /api/ext/records/{recordId}/report 用 */
    private String recordId;

    private String requestNo;

    private String title;

    private String channelCode;

    private String channelName;

    /** 渠道发布页入口地址（扩展打开发布页用） */
    private String publishEntryUrl;

    /** 渠道发布页 URL 匹配模式（扩展注入判定用） */
    private String publishUrlPattern;

    /** 按渠道映射渲染好的字段值（JSON 对象） */
    private JSONObject fieldsJson;

    /** 渠道字段映射（fields + selectors，popup 合成填充引擎 config 用） */
    private JSONObject fieldMapJson;

    /** 实例化深链 */
    private String deepLink;

    public static ExtDraftVO from(PublishDraft d, PublishRecord record, HrRequest request, Channel channel) {
        return ExtDraftVO.builder()
                .draftId(d.getId() == null ? null : String.valueOf(d.getId()))
                .recordId(record == null || record.getId() == null ? null : String.valueOf(record.getId()))
                .requestNo(request == null ? null : request.getRequestNo())
                .title(request == null ? null : request.getTitle())
                .channelCode(channel == null ? null : channel.getCode())
                .channelName(channel == null ? null : channel.getName())
                .publishEntryUrl(channel == null ? null : channel.getPublishEntryUrl())
                .publishUrlPattern(channel == null ? null : channel.getPublishUrlPattern())
                .fieldsJson(d.getFieldsJson() == null ? null : JSONObject.parseObject(d.getFieldsJson()))
                .fieldMapJson(channel == null || channel.getFieldMapJson() == null ? null : JSONObject.parseObject(channel.getFieldMapJson()))
                .deepLink(d.getDeepLink())
                .build();
    }
}
