package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 简历 LLM 打分结果（见 sql/resume_score_create_20260922_V1.sql 头注释）。
 *
 * <p>两种模式：match = 与需求单 JD 的匹配打分（requestId 非空）；
 * general = 无 JD 时的通用简历分析（requestId 为空）。</p>
 *
 * <p>input_json / details_json 同时兼任 AI 调用记录（一期训练样本数据源，
 * Python 服务保持无状态不直连业务库）。</p>
 */
@Data
@TableName("resume_score")
public class ResumeScore {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** 冗余：关联 candidate.id，按人查询用 */
    private Long candidateId;

    /** 打分对象 resume_version.id */
    private Long resumeVersionId;

    /** 冗余：关联 candidate_application.id（有投递事实时） */
    private Long applicationId;

    /** 参照需求单 hr_request.id；match 非空，general 为 null */
    private Long requestId;

    /** 幂等合成键：req:{requestId} / general（唯一键 uk_version_request 的一部分） */
    private String requestKey;

    /** match / general */
    private String scoreType;

    /** pending / success / failed */
    private String status;

    /** 总分 0-100；success 前为 null */
    private Integer score;

    /** LLM 总评（一段话） */
    private String summary;

    /** LLM 完整输出：score/summary/dimensions/highlights/risks/recommendation */
    private String detailsJson;

    /** 打分输入快照（简历文本 + JD 文本 + 候选人摘要），微调数据源 */
    private String inputJson;

    /** LLM 模型名（如 glm-4-flash） */
    private String model;

    /** 失败原因（超时/上游错误/解析失败） */
    private String failReason;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
