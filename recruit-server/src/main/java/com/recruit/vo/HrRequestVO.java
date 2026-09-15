package com.recruit.vo;

import com.recruit.entity.HrRequest;
import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 需求单详情 / 列表项
 */
@Data
@Builder
public class HrRequestVO {

    private Long id;

    /** 需求编号（REQ-YYYYMMDD-XXXX） */
    private String requestNo;

    private String title;

    private String deptName;

    private Integer headcountTotal;

    private Integer headcountFilled;

    private String jobDescription;

    private String jobRequirement;

    private Integer salaryMin;

    private Integer salaryMax;

    private String location;

    private String education;

    private Integer experienceYears;

    private String employmentType;

    /** draft/pending_approval/open/closed */
    private String status;

    private String closeReason;

    private Boolean autoClose;

    private String rejectReason;

    private LocalDateTime openedAt;

    private LocalDateTime closedAt;

    private Long createdBy;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;

    public static HrRequestVO from(HrRequest e) {
        return HrRequestVO.builder()
                .id(e.getId())
                .requestNo(e.getRequestNo())
                .title(e.getTitle())
                .deptName(e.getDeptName())
                .headcountTotal(e.getHeadcountTotal())
                .headcountFilled(e.getHeadcountFilled())
                .jobDescription(e.getJobDescription())
                .jobRequirement(e.getJobRequirement())
                .salaryMin(e.getSalaryMin())
                .salaryMax(e.getSalaryMax())
                .location(e.getLocation())
                .education(e.getEducation())
                .experienceYears(e.getExperienceYears())
                .employmentType(e.getEmploymentType())
                .status(e.getStatus())
                .closeReason(e.getCloseReason())
                .autoClose(e.getAutoClose())
                .rejectReason(e.getRejectReason())
                .openedAt(e.getOpenedAt())
                .closedAt(e.getClosedAt())
                .createdBy(e.getCreatedBy())
                .createdAt(e.getCreatedAt())
                .updatedAt(e.getUpdatedAt())
                .build();
    }
}
