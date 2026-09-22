package com.recruit.dto;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * 打分请求体（发给 recruit-ai-service 的 POST /api/v1/resume/score）。
 * 字段名与 Python 端 Pydantic 模型 camelCase 对齐。
 */
@Data
public class AiScoreRequestDTO {

    private Long resumeId;

    private Long candidateId;

    /** Java 侧从 fields_json 组装好的简历纯文本 */
    private String resumeText;

    /** 候选人摘要（不含联系方式；candidate 表本就只有 hash 无 PII） */
    private Map<String, Object> candidateSummary;

    /** 需求单信息；null = general 通用分析模式 */
    private JobInfo job;

    @Data
    public static class JobInfo {
        private Long requestId;
        private String title;
        private String jobDescription;
        private String jobRequirement;
        private Integer salaryMin;
        private Integer salaryMax;
        private String education;
        private Integer experienceYears;
        private String location;
    }
}
