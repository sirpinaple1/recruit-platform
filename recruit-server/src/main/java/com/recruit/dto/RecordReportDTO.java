package com.recruit.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 扩展端台账回填（见设计文档 §6.2）。
 * status=published 时建议回填 publishedUrl；failed 时建议回填 resultNote。
 */
@Data
public class RecordReportDTO {

    @NotBlank(message = "回填状态不能为空")
    @Pattern(regexp = "published|failed", message = "回填状态必须是 published/failed")
    private String status;

    @Size(max = 64, message = "账号标识不能超过 64 字")
    private String accountLabel;

    @Size(max = 512, message = "发布链接不能超过 512 字")
    private String publishedUrl;

    @Size(max = 512, message = "结果备注不能超过 512 字")
    private String resultNote;
}
