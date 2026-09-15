package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 发布台账（见设计文档 §5.4）
 * 与 publish_draft 一对一（draft_id 唯一）；approve 渲染草稿时同步建 pending 台账，
 * 扩展端回填终结为 published/failed；需求关闭/重渲染时未回填台账置 failed（保留审计）。
 */
@Data
@TableName("publish_record")
public class PublishRecord {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** 关联草稿 publish_draft.id（一对一） */
    private Long draftId;

    /** 冗余：所属需求 hr_request.id */
    private Long requestId;

    /** 冗余：渠道 channel.id */
    private Long channelId;

    /** pending/published/failed */
    private String status;

    /** 平台账号文本标识（非凭据，红线：永不采集凭据） */
    private String accountLabel;

    /** 发布成功后的岗位链接（HR 回填） */
    private String publishedUrl;

    /** 结果备注 */
    private String resultNote;

    /** 操作人 sys_user.id（扩展 token 关联用户） */
    private Long operatedBy;

    private LocalDateTime publishedAt;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
