package com.recruit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 人力需求单
 */
@Data
@TableName("hr_request")
public class HrRequest {

    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    /** 需求编号（REQ-YYYYMMDD-XXXX） */
    private String requestNo;

    /** 岗位名称 */
    private String title;

    /** 用人部门（一期不做组织表） */
    private String deptName;

    /** 计划招聘人数 */
    private Integer headcountTotal;

    /** 已入职数（手动修正） */
    private Integer headcountFilled;

    /** JD 正文（公开信息） */
    private String jobDescription;

    /** 任职要求（公开信息） */
    private String jobRequirement;

    /** 月薪下限（元） */
    private Integer salaryMin;

    /** 月薪上限（元） */
    private Integer salaryMax;

    /** 工作地点 */
    private String location;

    /** 学历要求（字典 education_level） */
    private String education;

    /** 要求工作年限 */
    private Integer experienceYears;

    /** 用工性质 full_time/part_time/internship/contract */
    private String employmentType;

    /** draft/pending_approval/open/closed */
    private String status;

    /** closed 时必填：filled/cancelled/frozen */
    private String closeReason;

    /** 招满自动关闭开关 */
    private Boolean autoClose;

    /** 最近一次驳回原因 */
    private String rejectReason;

    /** 开放时间（指标口径） */
    private LocalDateTime openedAt;

    /** 关闭时间（指标口径） */
    private LocalDateTime closedAt;

    /** 创建人 sys_user.id */
    private Long createdBy;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
