package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 驳回请求
 */
@Data
public class HrRequestRejectDTO {

    @NotBlank(message = "驳回原因不能为空")
    @Size(max = 256, message = "驳回原因不能超过256字")
    private String rejectReason;
}
