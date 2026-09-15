package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/** 扩展授权创建（响应里含一次性明文 token） */
@Data
public class ExtensionTokenCreateDTO {

    @NotBlank(message = "授权名称不能为空")
    @Size(max = 64, message = "授权名称不能超过 64 字")
    private String name;
}
