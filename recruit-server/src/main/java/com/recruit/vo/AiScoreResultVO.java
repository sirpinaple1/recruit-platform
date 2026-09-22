package com.recruit.vo;

import lombok.Data;

import java.util.List;

/**
 * 打分响应（recruit-ai-service 的返回）。
 *
 * <p>统一响应格式见 docs/conventions/java-python-integration.md §2.2：
 * {@code {code, message, data}}。data 里的 resume_id / score_type 是 snake_case，
 * 但这两个值调用方本来就有（自己发过去的），不声明即可 —— 剩余字段均为单词无下划线，
 * 无需任何命名策略注解（注意：Boot 4 是 Jackson 3 / tools.jackson 包名，
 * com.fasterxml 注解不可用）。</p>
 */
@Data
public class AiScoreResultVO {

    private Integer code;

    private String message;

    private DataBody data;

    @Data
    public static class DataBody {
        private Integer score;
        private String summary;
        private List<Dimension> dimensions;
        private List<String> highlights;
        private List<String> risks;
        /** recommend / maybe / not_recommend */
        private String recommendation;
        private String model;
    }

    @Data
    public static class Dimension {
        private String name;
        private Integer score;
        private String comment;
    }
}
