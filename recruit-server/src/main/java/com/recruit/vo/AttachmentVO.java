package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 附件列表项（候选人详情页展示）。
 */
@Data
@Builder
public class AttachmentVO {

    private String id;

    private String candidateId;

    private String resumeVersionId;

    private String platformFileId;

    private String fileName;

    private String contentType;

    private Long bytes;

    private String sha256;

    /** pending 待下载 / stored 已落盘 / failed 下载失败 */
    private String status;

    /** 下载失败原因（含平台状态码，Phase 0 V4 命题的证据） */
    private String failReason;

    private String sourceScene;

    /** 原始下载 URL（含票据，仅供排查；前端不直接使用） */
    private String originUrl;

    private LocalDateTime originTicketExpiresAt;

    private String storageKey;

    /**
     * 中台能否直接打开这份附件（= status 为 stored 且文件确实在存储中）。
     *
     * <p>刻意由服务端算好，而不是让前端自己按 status 推断：status 是**数据库里的意愿**，
     * 文件是否真在盘上是**另一个事实**。二者可能分叉（目录被手工清过、存储根换过），
     * 而前端唯一的补救手段就是点一下再报错 —— 不如一开始就把按钮藏掉。</p>
     */
    private Boolean openable;

    private LocalDateTime collectedAt;

    private LocalDateTime storedAt;

    private String operatedBy;

    /** 操作人姓名（getOperatedBy 的展示值） */
    private String operatorName;
}
