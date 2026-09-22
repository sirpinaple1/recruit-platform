package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 候选人详情（候选人 + 简历版本 + 附件 + 采集审计 + **投递**），对应框架 §4.1 的三层实体。
 */
@Data
@Builder
public class CandidateDetailVO {

    private CandidateVO candidate;

    /** 按采集时间倒序 */
    private List<ResumeVersionVO> versions;

    private List<AttachmentVO> attachments;

    /** 按发生时间倒序，append-only 的审计流水 */
    private List<CollectAuditVO> audits;

    /**
     * 该候选人的全部投递（人 × 平台岗位），按投递时间倒序。
     *
     * <p>空列表是<b>有意义的</b>：说明采集到的响应里就没有岗位线索
     * （典型是 {@code sourceChannel=recommend} 的候选人 —— 我方主动触达，
     * 对方并没有投任何岗），而不是系统漏了。</p>
     */
    private List<CandidateApplicationVO> applications;
}
