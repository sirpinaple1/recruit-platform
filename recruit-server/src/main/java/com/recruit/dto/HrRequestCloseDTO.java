package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 关闭请求
 */
@Data
public class HrRequestCloseDTO {

    /** filled/cancelled/frozen */
    @NotBlank(message = "关闭原因不能为空")
    @Size(max = 32, message = "关闭原因不能超过32字")
    private String closeReason;
}
