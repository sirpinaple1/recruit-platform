package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 候选人详情（候选人 + 简历版本 + 附件 + 采集审计），对应框架 §4.1 的三层实体。
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
}
