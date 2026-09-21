package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 扩展端提交采集的结果（框架 §2 Phase 1 验收：重复采集不产生重复数据，故逐项回报是否新建）。
 */
@Data
@Builder
public class ExtCollectResultVO {

    /** 落库（或命中已有）的候选人 ID */
    private String candidateId;

    /** true=本次新建候选人，false=命中已有（幂等） */
    private boolean candidateCreated;

    /** 本条采集对应的简历版本 ID */
    private String resumeVersionId;

    /** true=新建版本，false=内容相同被去重跳过（幂等键 content_hash） */
    private boolean resumeVersionCreated;

    /** 本次登记的附件 ID 列表（尚未落盘，需扩展端继续上传字节） */
    private List<String> attachmentIds;

    /** 审计记录 ID */
    private String auditId;

    /** 人类可读的结果说明，扩展端直接展示 */
    private String message;
}
