package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * JD 生成请求体（发给 recruit-ai-service 的 POST /api/v1/jd/generate）。
 * 字段名与 Python 端 Pydantic 模型 camelCase 对齐。
 */
@Data
public class AiJdRequestDTO {

    /** 岗位名称——生成的唯一必填要素，其余要素有则更具体 */
    @NotBlank(message = "岗位名称不能为空")
    @Size(max = 128)
    private String title;

    @Size(max = 128)
    private String deptName;

    private Integer salaryMin;

    private Integer salaryMax;

    @Size(max = 128)
    private String location;

    @Size(max = 32)
    private String education;

    private Integer experienceYears;

    @Size(max = 32)
    private String employmentType;

    /** HR 自由补充的背景描述（业务背景、方向偏好等），不落库、仅作生成素材 */
    @Size(max = 4000)
    private String background;
}
