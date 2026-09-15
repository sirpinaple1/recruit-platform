package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 渠道创建 / 编辑请求（PUT 为整体替换可编辑字段，全部字段必传）
 */
@Data
public class ChannelSaveDTO {

    @NotBlank(message = "渠道代码不能为空")
    @Size(max = 32, message = "渠道代码不能超过32字")
    private String code;

    @NotBlank(message = "渠道名称不能为空")
    @Size(max = 64, message = "渠道名称不能超过64字")
    private String name;

    @Size(max = 512, message = "发布页URL匹配模式不能超过512字")
    private String publishUrlPattern;

    /** 字段映射配置（合法 JSON 对象） */
    @NotBlank(message = "字段映射配置不能为空")
    private String fieldMapJson;

    @Size(max = 512, message = "深链模板不能超过512字")
    private String deepLinkTemplate;

    /** manual/api/connector/rpa，不传默认 manual */
    @Size(max = 16, message = "能力等级不能超过16字")
    private String capability;

    /** enabled/disabled，不传默认 enabled */
    @Size(max = 16, message = "状态不能超过16字")
    private String status;

    private Integer sortOrder;

    @Size(max = 256, message = "备注不能超过256字")
    private String remark;
}
