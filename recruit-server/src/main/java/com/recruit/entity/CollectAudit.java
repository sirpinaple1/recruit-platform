package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 采集审计（见 collect_audit_create 脚本头注释）。
 *
 * <p>append-only：只 INSERT，永不 UPDATE/DELETE。审计可信度的前提。</p>
 *
 * <p>为什么不复用 domain_event：那张表的列注释明确禁止写入候选人 PII，
 * 而采集审计必须记 page_url，BOSS 候选人页 URL 里带 uid。</p>
 */
@Data
@TableName("collect_audit")
public class CollectAudit {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** consent 采集前确认 / collect 提交采集 / attach_download 附件下载 / merge 归并 / skip 去重跳过 */
    private String action;

    /** ok / failed / skipped */
    private String result;

    /** 操作人 sys_user.id（扩展 token 关联用户） */
    private Long operatorId;

    /** 扩展授权 extension_token.id，泄露溯源用 */
    private Long extTokenId;

    private String platform;

    private String platformUserId;

    /** 落库后的 candidate.id；未落库为 NULL */
    private Long candidateId;

    /** 采集场景：list / detail / chat / attach */
    private String scene;

    /** 采集时页面 URL（含平台会话参数，合规自证材料） */
    private String pageUrl;

    private String sourceApi;

    private String clientNote;

    /** 动作发生时刻（客户端上报，UTC） */
    private LocalDateTime occurredAt;

    private LocalDateTime createdAt;
}
