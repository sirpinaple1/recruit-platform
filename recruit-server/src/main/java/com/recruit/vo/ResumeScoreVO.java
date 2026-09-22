package com.recruit.vo;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 简历打分结果（中台候选人详情「LLM 打分」展示用）。
 *
 * <p>ID 用 String 传输：雪花 ID 超出 JS 安全整数范围（沿用 CandidateVO 口径）。</p>
 */
@Data
@Builder
public class ResumeScoreVO {

    private String id;

    private String candidateId;

    private String resumeVersionId;

    /** match = 与需求单匹配打分；general = 通用简历分析 */
    private String scoreType;

    /** pending / success / failed */
    private String status;

    /** 总分 0-100；success 前为 null */
    private Integer score;

    /** LLM 总评 */
    private String summary;

    /** recommend / maybe / not_recommend；仅 match 模式有参考意义 */
    private String recommendation;

    /** 参照需求单（match 模式）；含岗位名便于展示 */
    private String requestId;

    private String requestTitle;

    private List<Dimension> dimensions;

    private List<String> highlights;

    private List<String> risks;

    /** LLM 模型名（如 glm-4-flash） */
    private String model;

    /** failed 时的失败原因 */
    private String failReason;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    @Data
    @Builder
    public static class Dimension {
        private String name;
        private Integer score;
        private String comment;
    }
}
