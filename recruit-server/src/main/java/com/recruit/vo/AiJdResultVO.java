package com.recruit.vo;

import lombok.Data;

/**
 * recruit-ai-service JD 生成接口的响应包装（{code, message, data}）。
 * 契约见 docs/conventions/java-python-integration.md §2.2。
 */
@Data
public class AiJdResultVO {

    private Integer code;

    private String message;

    private DataBody data;

    @Data
    public static class DataBody {
        private String jobDescription;
        private String jobRequirement;
        /** 生成所用模型（Python 侧回填，供前端展示/审计） */
        private String model;
    }
}
