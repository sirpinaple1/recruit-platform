package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
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
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.Set;

/**
 * 人力需求单 CRUD 与状态机
 */
@Log4j2
@RequiredArgsConstructor
@Service
public class HrRequestService {

    /** 用工性质合法值 */
    private static final Set<String> EMPLOYMENT_TYPES = Set.of("full_time", "part_time", "internship", "contract");

    /** 关闭原因合法值 */
    private static final Set<String> CLOSE_REASONS = Set.of("filled", "cancelled", "frozen");

    /** 编号取号冲突重试次数 */
    private static final int REQUEST_NO_RETRY = 3;

    /**
     * 状态转移表：action:当前状态 -> 目标状态。
     * 不在表内的组合即非法转移（抛 4xx），见 docs/design/channel-publish.md §5.1。
     */
    private static final Map<String, String> TRANSFERS = Map.of(
            "submit:draft", "pending_approval",
            "approve:pending_approval", "open",
            "reject:pending_approval", "draft",
            "close:open", "closed",
            "reopen:closed", "draft"
    );

    private final HrRequestMapper hrRequestMapper;
    private final PublishDraftService publishDraftService;

    // ==================== CRUD ====================

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

    /** 编辑（仅 draft 可编辑） */
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

    // ==================== 状态机 ====================

    /** 提交审批：draft -> pending_approval（提交前校验必填完整性） */
    public HrRequestVO submit(Long id) {
        HrRequest entity = requireById(id);
        String target = checkTransfer(entity, "submit");
        checkSubmittable(entity);
        entity.setStatus(target);
        hrRequestMapper.updateById(entity);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 审批通过：pending_approval -> open，写 opened_at，事务内为每个启用渠道渲染发布草稿 */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO approve(Long id) {
        HrRequest entity = requireById(id);
        String target = checkTransfer(entity, "approve");
        entity.setStatus(target);
        entity.setOpenedAt(LocalDateTime.now(ZoneOffset.UTC));
        hrRequestMapper.updateById(entity);
        // 渲染 publish_draft(pending)；台账 publish_record 在 T3.3 挂接
        publishDraftService.renderForRequest(entity);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 驳回：pending_approval -> draft，记录驳回原因 */
    public HrRequestVO reject(Long id, String rejectReason) {
        HrRequest entity = requireById(id);
        String target = checkTransfer(entity, "reject");
        entity.setStatus(target);
        entity.setRejectReason(rejectReason);
        hrRequestMapper.updateById(entity);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 关闭：open -> closed，写 closed_at + close_reason，未消费草稿置 cancelled */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO close(Long id, String closeReason) {
        if (!CLOSE_REASONS.contains(closeReason)) {
            throw new MyException(400, "关闭原因必须是 filled/cancelled/frozen");
        }
        HrRequest entity = requireById(id);
        String target = checkTransfer(entity, "close");
        entity.setStatus(target);
        entity.setCloseReason(closeReason);
        entity.setClosedAt(LocalDateTime.now(ZoneOffset.UTC));
        hrRequestMapper.updateById(entity);
        publishDraftService.cancelPendingByRequest(id);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 重新打开：closed -> draft，清空关闭痕迹 */
    public HrRequestVO reopen(Long id) {
        HrRequest entity = requireById(id);
        checkTransfer(entity, "reopen");
        // close_reason / closed_at 要显式置 null（updateById 默认忽略 null 字段）
        hrRequestMapper.update(null, new LambdaUpdateWrapper<HrRequest>()
                .eq(HrRequest::getId, id)
                .set(HrRequest::getStatus, "draft")
                .set(HrRequest::getCloseReason, null)
                .set(HrRequest::getClosedAt, null));
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 手动修正已入职数：open 状态下 filled >= total 且 auto_close 开启 -> 自动关闭（filled，未消费草稿置 cancelled） */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO updateHeadcount(Long id, Integer headcountFilled) {
        HrRequest entity = requireById(id);
        entity.setHeadcountFilled(headcountFilled);
        if ("open".equals(entity.getStatus())
                && Boolean.TRUE.equals(entity.getAutoClose())
                && headcountFilled >= entity.getHeadcountTotal()) {
            entity.setStatus("closed");
            entity.setCloseReason("filled");
            entity.setClosedAt(LocalDateTime.now(ZoneOffset.UTC));
            hrRequestMapper.updateById(entity);
            publishDraftService.cancelPendingByRequest(id);
        } else {
            hrRequestMapper.updateById(entity);
        }
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    // ==================== 内部方法 ====================

    /** 校验转移合法性：非法组合抛 4xx，合法返回目标状态 */
    private String checkTransfer(HrRequest entity, String action) {
        String target = TRANSFERS.get(action + ":" + entity.getStatus());
        if (target == null) {
            throw new MyException(400, "非法状态转移：" + action + " 不允许在 " + entity.getStatus() + " 状态执行");
        }
        return target;
    }

    /** 提交前必填校验（建单/编辑已保证，此处为流程兜底） */
    private void checkSubmittable(HrRequest entity) {
        if (!StringUtils.hasText(entity.getTitle()) || !StringUtils.hasText(entity.getDeptName())
                || entity.getHeadcountTotal() == null || !StringUtils.hasText(entity.getJobDescription())) {
            throw new MyException(400, "提交前请完善岗位名称/用人部门/计划招聘人数/JD正文");
        }
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
