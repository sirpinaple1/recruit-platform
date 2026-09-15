package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 发布草稿
 */
@Data
@TableName("publish_draft")
public class PublishDraft {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** 所属需求 hr_request.id */
    private Long requestId;

    /** 渠道 channel.id */
    private Long channelId;

    /** 按渠道映射渲染好的字段值（仅白名单公开字段） */
    private String fieldsJson;

    /** 实例化深链（{requestNo} 已替换） */
    private String deepLink;

    /** pending/consumed/cancelled */
    private String status;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
