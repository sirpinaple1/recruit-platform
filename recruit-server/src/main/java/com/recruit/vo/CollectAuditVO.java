package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 采集审计列表项（候选人详情页展示「谁在什么时候采了什么」，框架 §3 Phase 3.3 的雏形）。
 */
@Data
@Builder
public class CollectAuditVO {

    private String id;

    private String action;

    private String result;

    private String operatorId;

    /** 操作人姓名（getOperatorId 的展示值） */
    private String operatorName;

    private String platform;

    private String platformUserId;

    private String candidateId;

    private String scene;

    private String pageUrl;

    private String sourceApi;

    private String clientNote;

    private LocalDateTime occurredAt;

    private LocalDateTime createdAt;
}
