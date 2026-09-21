package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 简历版本列表项（候选人详情页展示）。
 *
 * <p>fieldsJson 直接把归一后的字段 JSON 字符串透出，前端自行解析展示 ——
 * 一期字段集尚未稳定（Phase 0 实测发现平台至少三套命名），过早固化结构会反复返工。</p>
 */
@Data
@Builder
public class ResumeVersionVO {

    private String id;

    private String candidateId;

    /** chat 聊天 / list 列表 / detail 详情页 */
    private String source;

    private String sourceApi;

    private String platformResumeId;

    /** 归一后的字段 JSON 字符串 */
    private String fieldsJson;

    private Integer fieldCount;

    /** 1=原始快照是密文原文，一期未解密 */
    private Integer rawEncrypted;

    /** 原始快照字符数（截断前） */
    private Integer rawBytes;

    /** 1=扩展端截断，不可当完整证据 */
    private Integer rawTruncated;

    private String contentHash;

    private String sourceUrl;

    private LocalDateTime collectedAt;

    private String operatedBy;

    /** 操作人姓名（getOperatedBy 的展示值） */
    private String operatorName;
}
