package com.recruit.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * 扩展端提交采集（见《Chrome插件简历采集-分阶段任务框架》§2 Phase 1.2 接口契约）。
 *
 * <p>一次请求 = HR 的一次主动采集动作。服务端在同一事务内完成
 * 候选人幂等归并 → 简历版本去重 → 附件登记 → 审计落库。</p>
 *
 * <p>合规前提（框架 §6 红线第 1 条）：本接口只在 HR 明确点击「采集」后由扩展调用，
 * 因此 consent 为必填 —— 没有明示动作的请求一律拒绝。</p>
 */
@Data
public class ExtCollectSubmitDTO {

    @NotBlank(message = "平台标识不能为空")
    @Size(max = 32, message = "平台标识不能超过 32 字")
    private String platform;

    /** 采集前确认（HR 的明示动作），必填 */
    @NotNull(message = "缺少采集前确认")
    @Valid
    private Consent consent;

    @NotEmpty(message = "候选人列表不能为空")
    @Size(max = 50, message = "单次提交候选人不能超过 50 条（逐条采集，不支持整页批量）")
    @Valid
    private List<CandidatePayload> candidates;

    /** 采集前确认记录 */
    @Data
    public static class Consent {

        @NotNull(message = "确认标记不能为空")
        private Boolean confirmed;

        /** 客户端确认时刻（UTC）；服务端只做审计记录，不作为业务时间 */
        private LocalDateTime ts;

        @Size(max = 1024, message = "页面 URL 不能超过 1024 字")
        private String pageUrl;

        /** 确认发生的场景：list / detail / chat / attach */
        @Size(max = 32)
        private String scene;
    }

    /** 单个候选人的采集数据 */
    @Data
    public static class CandidatePayload {

        @NotBlank(message = "候选人平台 ID 不能为空")
        @Size(max = 64, message = "候选人平台 ID 不能超过 64 字")
        private String platformUserId;

        /**
         * **同一个人的另一种 ID 形态**（备用键）。
         *
         * <p>BOSS 同一个人有两种 ID：聊天消息 / 会话列表给数字 uid（`608120464`），
         * 候选人卡片 / 简历详情给加密 geekId（`01858de472ad39180XRy2t-9FFRU`）。
         * 扩展从**同一个候选人对象**上把另一种形态取出来带上，服务端用它做写入时归一 ——
         * 只按主键单键查会让「先采到数字、后采到加密」分裂成两条候选人记录
         * （2026-09-21 实测：陈诗健、谢建广各中一次）。</p>
         *
         * <p>⚠️ 这个值**会参与候选人幂等查找**（写入 `candidate.platform_user_id_alt`），
         * 所以**必须确保它属于同一个人** —— 混入别人的 ID 会把那个人的采集吸到这条记录上。
         * 取值只允许来自：同一候选人节点上的备用 ID、跨 ID 空间映射表、来源 URL 的 gid/geekId。</p>
         *
         * <p>另外它仍会写进 {@code candidate.source_platform_user_raw}（首次采集时的原始对照）。</p>
         */
        @Size(max = 64, message = "备用 ID 不能超过 64 字")
        private String secondaryPlatformUserId;

        /** 采集来源渠道：chat 候选人主动来 / recommend 我方主动发 */
        @Size(max = 32)
        private String sourceChannel;

        /** 采集场景：list / detail / chat / attach */
        @Size(max = 32)
        private String scene;

        @Size(max = 1024)
        private String pageUrl;

        /** 数据实际来源接口路径 */
        @Size(max = 255)
        private String sourceApi;

        /** 采集链路：chat / list / detail（对应 resume_version.source） */
        @Size(max = 32)
        private String source;

        /** 数据来源 URL（页面侧绝对化后） */
        @Size(max = 1024)
        private String sourceUrl;

        @Size(max = 128)
        private String platformResumeId;

        /** 归一后的结构化字段（工作经历/教育经历/期望等） */
        private Map<String, Object> fields;

        /** 原始响应体快照；详情页密文原样传入 */
        @Size(max = 1048576, message = "原始快照不能超过 1MB")
        private String raw;

        /** 1=raw 为密文原文，一期不解密 */
        private Integer rawEncrypted;

        /** 原始快照字符数（截断前） */
        private Integer rawBytes;

        /** 1=原始快照在扩展端被截断 */
        private Integer rawTruncated;

        /** 采集时刻（客户端上报，UTC） */
        private LocalDateTime collectedAt;

        /**
         * 手机号（可选，多数场景平台不展示）。
         * 红线：服务端只在内存中做 SHA-256 后落库，原文既不持久化也不写日志。
         */
        @Size(max = 32)
        private String phone;

        /** 邮箱（可选）。同 phone，只存 hash。 */
        @Size(max = 128)
        private String email;

        @Valid
        @Size(max = 20, message = "单候选人附件不能超过 20 个")
        private List<AttachmentPayload> attachments;
    }

    /** 附件登记（此时只登记元数据，字节由后续上传接口补） */
    @Data
    public static class AttachmentPayload {

        /** 平台侧文件标识，构造口径见 attachment 建表脚本头注释 */
        @NotBlank
        @Size(max = 191, message = "平台文件标识不能超过 191 字")
        private String platformFileId;

        /** 原始下载 URL（含票据参数） */
        @NotBlank
        @Size(max = 1024, message = "附件 URL 不能超过 1024 字")
        private String originUrl;

        @Size(max = 255)
        private String fileName;

        @Size(max = 128)
        private String contentType;

        private Long bytes;

        /** 票据有效期（来自平台的 expireDate） */
        private LocalDateTime ticketExpiresAt;

        /** attach 附件预览 / chat 聊天文件 */
        @Size(max = 32)
        private String sourceScene;
    }
}
