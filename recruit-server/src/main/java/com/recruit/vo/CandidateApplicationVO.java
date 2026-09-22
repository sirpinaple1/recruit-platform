package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 候选人投递项（详情页展示「这个人投过哪些岗位」）。
 *
 * <p>ID 用 String 传输：雪花 ID 超出 JS 安全整数范围（沿用 CandidateVO 口径）。</p>
 *
 * <p><b>{@link #requestId} 为空的含义</b>：该投递的平台岗位在中台还没有映射，
 * 所以归不到具体职位。此时 {@link #platformJobHint}（平台原文，如
 * 「9月21日 沟通的职位-Java」）是 HR 人工认领时唯一的判断依据 ——
 * 所以它在详情里必须透出，不能只留在库里。</p>
 */
@Data
@Builder
public class CandidateApplicationVO {

    private String id;

    private String candidateId;

    private String platform;

    /** 平台侧岗位 ID（BOSS jobId）—— 建立映射时 HR 要填的就是这个值 */
    private String platformJobId;

    /** 平台原文岗位线索（拼接文本，仅供人工辨认，不参与自动判定） */
    private String platformJobHint;

    /** 解析出的需求单 ID；null = 尚未归类 */
    private String requestId;

    /** 需求单编号（REQ-YYYYMMDD-XXXX），便于人看 */
    private String requestNo;

    /** 需求单岗位名称 */
    private String requestTitle;

    /** 采集来源渠道：chat 候选人主动来 / recommend 我方主动发 */
    private String sourceChannel;

    private String firstResumeVersionId;

    /** 投递时刻（UTC）：取自简历版本 collected_at */
    private LocalDateTime appliedAt;

    private LocalDateTime createdAt;
}
