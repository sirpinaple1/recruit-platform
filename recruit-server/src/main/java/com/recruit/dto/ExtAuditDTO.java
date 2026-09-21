package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 扩展端审计上报（框架 §2 Phase 1.4）。
 *
 * <p>用于「已做确认但未提交」「提交失败」这类动作的独立留痕 —— 提交成功的那次
 * 由 {@code POST /api/ext/collect/resumes} 在同一事务内自动写审计，不重复上报。</p>
 */
@Data
public class ExtAuditDTO {

    @NotBlank(message = "动作不能为空")
    @Pattern(regexp = "consent|collect|attach_download|merge|skip",
            message = "动作必须是 consent/collect/attach_download/merge/skip")
    private String action;

    @Pattern(regexp = "ok|failed|skipped", message = "结果必须是 ok/failed/skipped")
    private String result;

    @NotBlank(message = "平台标识不能为空")
    @Size(max = 32)
    private String platform;

    @Size(max = 64)
    private String platformUserId;

    @Size(max = 32)
    private String scene;

    @Size(max = 1024, message = "页面 URL 不能超过 1024 字")
    private String pageUrl;

    @Size(max = 255)
    private String sourceApi;

    @Size(max = 512, message = "补充说明不能超过 512 字")
    private String note;

    /** 动作发生时刻（客户端上报，UTC）；为空则取服务端当前时间 */
    private LocalDateTime occurredAt;
}
