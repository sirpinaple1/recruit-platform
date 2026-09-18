package com.recruit.dto;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 需求单创建 / 编辑请求。
 *
 * 必填对齐渠道发布页（BOSS）必填项：经验 / 学历 / 薪资范围不可为空——
 * 缺值会渲染出残缺草稿，渠道填充必然失败。
 * 其余可选字段（location / employmentType 等）PUT 传 null 不覆盖库中已有值。
 */
@Data
public class HrRequestSaveDTO {

    @NotBlank(message = "岗位名称不能为空")
    @Size(max = 128, message = "岗位名称不能超过128字")
    private String title;

    @NotBlank(message = "用人部门不能为空")
    @Size(max = 64, message = "用人部门不能超过64字")
    private String deptName;

    /** 不传默认 1 */
    @Min(value = 1, message = "计划招聘人数至少为1")
    private Integer headcountTotal;

    @NotBlank(message = "JD正文不能为空")
    private String jobDescription;

    private String jobRequirement;

    @NotNull(message = "薪资范围（下限）不能为空")
    @Min(value = 0, message = "薪资下限不能为负数")
    private Integer salaryMin;

    @NotNull(message = "薪资范围（上限）不能为空")
    @Min(value = 0, message = "薪资上限不能为负数")
    private Integer salaryMax;

    @Size(max = 128, message = "工作地点不能超过128字")
    private String location;

    @NotBlank(message = "学历要求不能为空")
    @Size(max = 32, message = "学历要求不能超过32字")
    private String education;

    @NotNull(message = "要求工作年限不能为空")
    @Min(value = 0, message = "工作年限不能为负数")
    private Integer experienceYears;

    /** full_time/part_time/internship/contract */
    @Size(max = 32, message = "用工性质不能超过32字")
    private String employmentType;

    /** 招满自动关闭开关，不传默认开 */
    private Boolean autoClose;

    /** 薪资倒挂校验：下限不得大于上限（null 由各自 @NotNull 拦截） */
    @AssertTrue(message = "薪资下限不能大于上限")
    public boolean isSalaryRangeValid() {
        return salaryMin == null || salaryMax == null || salaryMin <= salaryMax;
    }
}
