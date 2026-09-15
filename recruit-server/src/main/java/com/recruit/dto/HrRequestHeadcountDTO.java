package com.recruit.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

/**
 * 手动修正已入职数请求
 */
@Data
public class HrRequestHeadcountDTO {

    @NotNull(message = "已入职数不能为空")
    @Min(value = 0, message = "已入职数不能为负数")
    private Integer headcountFilled;
}
