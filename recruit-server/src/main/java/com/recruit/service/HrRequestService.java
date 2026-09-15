package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.recruit.common.MyException;
import com.recruit.dto.HrRequestSaveDTO;
import com.recruit.entity.HrRequest;
import com.recruit.mapper.HrRequestMapper;
import com.recruit.vo.HrRequestVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.log4j.Log4j2;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Set;

/**
 * 人力需求单 CRUD
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class HrRequestService {

    /** 用工性质合法值 */
    private static final Set<String> EMPLOYMENT_TYPES = Set.of("full_time", "part_time", "internship", "contract");

    /** 编号取号冲突重试次数 */
    private static final int REQUEST_NO_RETRY = 3;

    private final HrRequestMapper hrRequestMapper;

    /** 建单（status 固定 draft，编号服务端生成） */
    public HrRequestVO create(HrRequestSaveDTO dto, Long userId) {
        validate(dto);
        HrRequest entity = new HrRequest();
        copyEditableFields(entity, dto);
        if (dto.getAutoClose() != null) {
            entity.setAutoClose(dto.getAutoClose());
        }
        entity.setStatus("draft");
        entity.setHeadcountFilled(0);
        entity.setCreatedBy(userId);
        insertWithRequestNo(entity);
        return HrRequestVO.from(hrRequestMapper.selectById(entity.getId()));
    }

    /** 分页列表（可按状态筛选，新单在前） */
    public IPage<HrRequestVO> page(long page, long size, String status) {
        LambdaQueryWrapper<HrRequest> wrapper = new LambdaQueryWrapper<HrRequest>()
                .eq(StringUtils.hasText(status), HrRequest::getStatus, status)
                .orderByDesc(HrRequest::getId);
        return hrRequestMapper.selectPage(Page.of(page, size), wrapper).convert(HrRequestVO::from);
    }

    /** 详情 */
    public HrRequestVO getById(Long id) {
        return HrRequestVO.from(requireById(id));
    }

    /** 编辑（仅 draft 可编辑，状态流转见 T2.2） */
    public HrRequestVO update(Long id, HrRequestSaveDTO dto) {
        validate(dto);
        HrRequest entity = requireById(id);
        if (!"draft".equals(entity.getStatus())) {
            throw new MyException(400, "仅草稿状态的需求单可编辑");
        }
        copyEditableFields(entity, dto);
        if (dto.getAutoClose() != null) {
            entity.setAutoClose(dto.getAutoClose());
        }
        hrRequestMapper.updateById(entity);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    private HrRequest requireById(Long id) {
        HrRequest entity = hrRequestMapper.selectById(id);
        if (entity == null) {
            throw new MyException(404, "需求单不存在");
        }
        return entity;
    }

    private void validate(HrRequestSaveDTO dto) {
        if (dto.getSalaryMin() != null && dto.getSalaryMax() != null
                && dto.getSalaryMin() > dto.getSalaryMax()) {
            throw new MyException(400, "薪资下限不能大于上限");
        }
        if (dto.getEmploymentType() != null && !EMPLOYMENT_TYPES.contains(dto.getEmploymentType())) {
            throw new MyException(400, "用工性质必须是 full_time/part_time/internship/contract");
        }
    }

    /** 可编辑字段拷贝（状态/编号/入职数等不在编辑范围） */
    private void copyEditableFields(HrRequest entity, HrRequestSaveDTO dto) {
        entity.setTitle(dto.getTitle());
        entity.setDeptName(dto.getDeptName());
        entity.setHeadcountTotal(dto.getHeadcountTotal() == null ? 1 : dto.getHeadcountTotal());
        entity.setJobDescription(dto.getJobDescription());
        entity.setJobRequirement(dto.getJobRequirement());
        entity.setSalaryMin(dto.getSalaryMin());
        entity.setSalaryMax(dto.getSalaryMax());
        entity.setLocation(dto.getLocation());
        entity.setEducation(dto.getEducation());
        entity.setExperienceYears(dto.getExperienceYears());
        entity.setEmploymentType(dto.getEmploymentType());
    }

    /** 生成编号 REQ-YYYYMMDD-XXXX：当日最大序号 +1，唯一键冲突时重取（并发兜底） */
    private void insertWithRequestNo(HrRequest entity) {
        for (int attempt = 1; attempt <= REQUEST_NO_RETRY; attempt++) {
            entity.setRequestNo(nextRequestNo());
            try {
                hrRequestMapper.insert(entity);
                return;
            } catch (DuplicateKeyException e) {
                log.warn("需求编号取号冲突，第{}次重试", attempt);
            }
        }
        throw new MyException(409, "需求编号生成冲突，请重试");
    }

    private String nextRequestNo() {
        String prefix = "REQ-" + LocalDate.now(ZoneOffset.UTC).format(DateTimeFormatter.BASIC_ISO_DATE) + "-";
        HrRequest last = hrRequestMapper.selectOne(new LambdaQueryWrapper<HrRequest>()
                .likeRight(HrRequest::getRequestNo, prefix)
                .orderByDesc(HrRequest::getRequestNo)
                .last("LIMIT 1"));
        int next = last == null ? 1 : Integer.parseInt(last.getRequestNo().substring(prefix.length())) + 1;
        return prefix + String.format("%04d", next);
    }
}
