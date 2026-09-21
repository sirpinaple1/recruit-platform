package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 简历附件（见 attachment_create 脚本头注释）。
 *
 * <p>Phase 0 实测确认：附件不在任何 JSON 响应里，是平台生成的 PDF，走独立下载端点。
 * 幂等键 platformFileId 由 URL **路径**构造（不含易变票据）：
 * {@code <端点段>:<文件 ID>}，例如 {@code download4boss:01858de472ad39180XRy2t-9FFRU}。</p>
 */
@Data
@TableName("attachment")
public class Attachment {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    private Long candidateId;

    /** 关联 resume_version.id；附件先于结构化数据到达时为 NULL */
    private Long resumeVersionId;

    private String platform;

    /** 平台侧文件标识，构造口径见脚本头注释 */
    private String platformFileId;

    private String fileName;

    private String contentType;

    private Long bytes;

    /** 文件内容 SHA-256，下载成功后回填 */
    private String sha256;

    /** 原始下载 URL（含票据参数，重放用） */
    private String originUrl;

    /** 票据有效期；NULL=平台未返回 */
    private LocalDateTime originTicketExpiresAt;

    /** 本地存储相对路径；未落盘为 NULL */
    private String storageKey;

    /** pending 待下载 / stored 已落盘 / failed 下载失败 */
    private String status;

    private String failReason;

    /** attach 附件预览 / chat 聊天文件 */
    private String sourceScene;

    private LocalDateTime collectedAt;

    private LocalDateTime storedAt;

    private Long operatedBy;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
