package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 简历版本（见 resume_version_create 脚本头注释）。
 *
 * <p>同候选人下按 contentHash 去重：内容一致则复用旧版本，重复点采集不产生新行。</p>
 *
 * <p>raw 用文本而非 JSON 列：在线简历详情页返回的是密文串，不是合法 JSON。
 * rawEncrypted=1 表示 rawJson 是密文原文，一期不解密（见 Phase 0 ADJUST-1）。</p>
 */
@Data
@TableName("resume_version")
public class ResumeVersion {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    private Long candidateId;

    /** 冗余：来源平台，便于按平台对账 */
    private String platform;

    /** 采集链路：chat 聊天 / list 列表 / detail 详情页 */
    private String source;

    /** 具体接口路径 */
    private String sourceApi;

    /** 平台侧简历 ID（如 encryptResumeId），有则填 */
    private String platformResumeId;

    /** 归一后的结构化字段 */
    private String fieldsJson;

    private Integer fieldCount;

    /** 原始响应体快照；详情页密文原样存于此 */
    private String rawJson;

    /** 1=rawJson 为密文原文，一期不解密 */
    private Integer rawEncrypted;

    /** 原始快照字符数（截断前） */
    private Integer rawBytes;

    /** 1=原始快照在扩展端被截断，不可当完整证据 */
    private Integer rawTruncated;

    /** 归一字段 JSON 的 SHA-256，同候选人内去重键 */
    private String contentHash;

    private String sourceUrl;

    private LocalDateTime collectedAt;

    private Long operatedBy;

    private LocalDateTime createdAt;
}
