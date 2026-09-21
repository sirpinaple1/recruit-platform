package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

/**
 * 附件字节上传结果（扩展端 SW 重放下载成功后回传）。
 */
@Data
@Builder
public class ExtAttachmentContentVO {

    private String attachmentId;

    /** stored 已落盘 / failed 失败 */
    private String status;

    /** 实际落盘字节数 */
    private Long bytes;

    /** 服务端实算的文件 SHA-256（与客户端声明不一致时以服务端为准） */
    private String sha256;

    private String fileName;

    /** 落盘相对路径 */
    private String storageKey;

    private String message;
}
