package com.recruit.vo;

import com.alibaba.fastjson2.JSONObject;
import com.recruit.entity.Channel;
import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 渠道详情 / 列表项
 */
@Data
@Builder
public class ChannelVO {

    /** 雪花 ID：超 JS 安全整数范围，用 String 传输防前端丢精度 */
    private String id;

    private String code;

    private String name;

    private String publishUrlPattern;

    /** 字段映射配置（输出为 JSON 对象而非转义字符串，方便前端/扩展直接消费） */
    private JSONObject fieldMapJson;

    private String deepLinkTemplate;

    private String capability;

    private String status;

    private Integer sortOrder;

    private String remark;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    public static ChannelVO from(Channel e) {
        return ChannelVO.builder()
                .id(e.getId() == null ? null : String.valueOf(e.getId()))
                .code(e.getCode())
                .name(e.getName())
                .publishUrlPattern(e.getPublishUrlPattern())
                .fieldMapJson(e.getFieldMapJson() == null ? null : JSONObject.parseObject(e.getFieldMapJson()))
                .deepLinkTemplate(e.getDeepLinkTemplate())
                .capability(e.getCapability())
                .status(e.getStatus())
                .sortOrder(e.getSortOrder())
                .remark(e.getRemark())
                .createdAt(e.getCreatedAt())
                .updatedAt(e.getUpdatedAt())
                .build();
    }
}
