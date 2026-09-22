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

    /**
     * 平台侧岗位 ID（BOSS jobId，如 575500411）—— **机器映射键**。
     *
     * <p>与 {@link #publishedUrl} 的区别别混用：那个是人工可读的链接（可能带易变票据参数），
     * 这个是稳定的等值映射键，用于把 {@code candidate_application.platform_job_id}
     * 解析回 {@code hr_request.id}。二者可能同时有值，也可能只有其一。</p>
     */
    private String platformJobId;

    /**
     * 岗位 ID 来源：{@code NULL} 未绑定 / {@code auto} 扩展自动捕获 / {@code manual} 中台人工绑定。
     *
     * <p>这一列存在的唯一理由是**防「自动覆盖人工」**：自动流程只在为 NULL 时写入，
     * 人工可覆盖任何状态。没有它，HR 手工纠正过的绑定会在下一次自动上报时被静默改回。</p>
     */
    private String platformJobBindSource;

    /** 绑定岗位的操作人 sys_user.id（bind_source=manual 时有值，人工动作须可追溯） */
    private Long platformJobBoundBy;

    /** 结果备注 */
    private String resultNote;

    /** 操作人 sys_user.id（扩展 token 关联用户） */
    private Long operatedBy;

    private LocalDateTime publishedAt;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
