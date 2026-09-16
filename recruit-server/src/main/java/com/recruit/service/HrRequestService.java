package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.recruit.common.DomainEventTypes;
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
import java.time.ZoneId;
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
     * 编号日期基准时区。
     *
     * <p>业务可见编号（REQ-YYYYMMDD-XXXX）用北京时区而非 UTC：UTC 存储是内部约定，
     * 但单号是给人看的——若按 UTC 取日期，CST 00:00–08:00 建的单会显示成前一天，
     * 与 HR 当天的工作认知冲突（P1-3）。时间列本身仍按 UTC 存储，两者互不影响。</p>
     *
     * <p>包级可见：单测直接断言该常量，把「用北京时区编号」这个决策钉住——
     * 有人改回 UTC 时测试会红并强制确认。完全行为化的验证需要可注入的 Clock，
     * 属于 P2 的确定性时间改造，本期不引入。</p>
     */
    static final ZoneId NUMBERING_ZONE = ZoneId.of("Asia/Shanghai");

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
    private final PublishRecordService publishRecordService;
    private final DomainEventService domainEventService;

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
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO submit(Long id, Long operatorId) {
        HrRequest entity = requireById(id);
        String from = entity.getStatus();
        String target = checkTransfer(entity, "submit");
        checkSubmittable(entity);
        casStatus(id, from, "submit", new LambdaUpdateWrapper<HrRequest>()
                .set(HrRequest::getStatus, target));
        emit(DomainEventTypes.HR_REQUEST_SUBMITTED, entity, from, target, operatorId);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 审批通过：pending_approval -> open，写 opened_at，事务内为每个启用渠道渲染发布草稿 */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO approve(Long id, Long operatorId) {
        HrRequest entity = requireById(id);
        String from = entity.getStatus();
        String target = checkTransfer(entity, "approve");
        LocalDateTime openedAt = LocalDateTime.now(ZoneOffset.UTC);
        casStatus(id, from, "approve", new LambdaUpdateWrapper<HrRequest>()
                .set(HrRequest::getStatus, target)
                .set(HrRequest::getOpenedAt, openedAt));
        // CAS 成功后把本地实体同步到新状态，供后续渲染复用（避免渲染到旧状态）
        entity.setStatus(target);
        entity.setOpenedAt(openedAt);
        emit(DomainEventTypes.HR_REQUEST_APPROVED, entity, from, target, operatorId);
        // 事务内渲染 publish_draft(pending) + publish_record(pending)（§5.3/§5.4）
        publishDraftService.renderForRequest(entity);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 驳回：pending_approval -> draft，记录驳回原因 */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO reject(Long id, String rejectReason, Long operatorId) {
        HrRequest entity = requireById(id);
        String from = entity.getStatus();
        String target = checkTransfer(entity, "reject");
        casStatus(id, from, "reject", new LambdaUpdateWrapper<HrRequest>()
                .set(HrRequest::getStatus, target)
                .set(HrRequest::getRejectReason, rejectReason));
        emit(DomainEventTypes.HR_REQUEST_REJECTED, entity, from, target, operatorId);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 关闭：open -> closed，写 closed_at + close_reason，未消费草稿置 cancelled */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO close(Long id, String closeReason, Long operatorId) {
        if (!CLOSE_REASONS.contains(closeReason)) {
            throw new MyException(400, "关闭原因必须是 filled/cancelled/frozen");
        }
        HrRequest entity = requireById(id);
        String from = entity.getStatus();
        String target = checkTransfer(entity, "close");
        casStatus(id, from, "close", new LambdaUpdateWrapper<HrRequest>()
                .set(HrRequest::getStatus, target)
                .set(HrRequest::getCloseReason, closeReason)
                .set(HrRequest::getClosedAt, LocalDateTime.now(ZoneOffset.UTC)));
        emit(DomainEventTypes.HR_REQUEST_CLOSED, entity, from, target, operatorId);
        // 未消费草稿置 cancelled；未回填台账置 failed（行保留审计，§5.4）
        publishDraftService.cancelPendingByRequest(id);
        publishRecordService.failPendingByRequest(id, "需求关闭（" + closeReason + "），未发布草稿作废");
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 重新打开：closed -> draft，清空关闭痕迹 */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO reopen(Long id, Long operatorId) {
        HrRequest entity = requireById(id);
        String from = entity.getStatus();
        checkTransfer(entity, "reopen");
        // close_reason / closed_at 要显式置 null（updateById 默认忽略 null 字段）
        casStatus(id, "closed", "reopen", new LambdaUpdateWrapper<HrRequest>()
                .set(HrRequest::getStatus, "draft")
                .set(HrRequest::getCloseReason, null)
                .set(HrRequest::getClosedAt, null));
        emit(DomainEventTypes.HR_REQUEST_REOPENED, entity, from, "draft", operatorId);
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    /** 手动修正已入职数：open 状态下 filled >= total 且 auto_close 开启 -> 自动关闭（filled，未消费草稿置 cancelled） */
    @Transactional(rollbackFor = Exception.class)
    public HrRequestVO updateHeadcount(Long id, Integer headcountFilled, Long operatorId) {
        HrRequest entity = requireById(id);
        if ("open".equals(entity.getStatus())
                && Boolean.TRUE.equals(entity.getAutoClose())
                && headcountFilled >= entity.getHeadcountTotal()) {
            casStatus(id, "open", "招满自动关闭", new LambdaUpdateWrapper<HrRequest>()
                    .set(HrRequest::getHeadcountFilled, headcountFilled)
                    .set(HrRequest::getStatus, "closed")
                    .set(HrRequest::getCloseReason, "filled")
                    .set(HrRequest::getClosedAt, LocalDateTime.now(ZoneOffset.UTC)));
            // 事件类型区分「自动关闭」与人工 close，便于口径区分
            emit(DomainEventTypes.HR_REQUEST_AUTO_CLOSED, entity, "open", "closed", operatorId);
            publishDraftService.cancelPendingByRequest(id);
            publishRecordService.failPendingByRequest(id, "招满自动关闭（filled），未发布草稿作废");
        } else {
            // 不改状态：窄写入（只写 headcount_filled），避免整实体回写覆盖并发改动
            hrRequestMapper.update(null, new LambdaUpdateWrapper<HrRequest>()
                    .eq(HrRequest::getId, id)
                    .set(HrRequest::getHeadcountFilled, headcountFilled));
        }
        return HrRequestVO.from(hrRequestMapper.selectById(id));
    }

    // ==================== 内部方法 ====================

    /**
     * 条件状态转移（乐观并发控制）：{@code UPDATE ... SET ... WHERE id = ? AND status = <期望源状态>}。
     *
     * <p><b>为什么 rows == 0 可以判定为冲突</b>：本方法只用于「改变 status」的转移，
     * 而 {@link #TRANSFERS} 的每个目标状态与源状态必然不同（draft↔pending_approval↔open↔closed 之间无自环），
     * 因此被 WHERE 命中的行一定发生了实际变更——无论驱动返回的是「匹配行数」还是「变更行数」，
     * rows 都不可能是 0。于是 rows == 0 严格等价于「WHERE 未命中」，即状态已被其他请求抢先改变。
     * 这一判定不依赖 JDBC 的 useAffectedRows 配置，故无需在连接串上做额外约定。</p>
     *
     * <p><b>为什么必须有它</b>：原实现是「先 selectById 判状态，再 updateById 写回」，
     * 两个并发请求会同时通过检查：approve 并发会导致重复渲染草稿（破坏「同一 (request, channel)
     * 只一条 pending」的约束），close 并发会导致重复联动作废。CAS 把「检查」与「写入」压成一条
     * 原子语句，把并发正确的责任交给数据库行锁，而不是应用层时序。</p>
     *
     * @param expectedStatus 期望的源状态（取自 CAS 前的读取）
     * @param action         动作名，仅用于冲突提示文案
     * @param sets           要写入的列（须包含 status 的目标值）
     */
    private void casStatus(Long id, String expectedStatus, String action, LambdaUpdateWrapper<HrRequest> sets) {
        int rows = hrRequestMapper.update(null, sets
                .eq(HrRequest::getId, id)
                .eq(HrRequest::getStatus, expectedStatus));
        if (rows == 0) {
            throw new MyException(409, "操作失败：" + action + " 期望需求单处于 " + expectedStatus
                    + " 状态，但已被其他操作变更，请刷新后重试");
        }
    }

    /**
     * 记录状态转移事件（P1-2）。
     *
     * <p>调用点全部落在 {@code @Transactional} 方法内，因此事件与状态变更同事务提交；
     * 已用 CAS 保证「本次转移确实生效」之后才记录，不会为一次失败的转移留下事件。</p>
     */
    private void emit(String eventType, HrRequest entity, String fromStatus, String toStatus, Long operatorId) {
        domainEventService.hrRequestTransition(
                eventType, entity.getId(), entity.getRequestNo(), fromStatus, toStatus, operatorId);
    }

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
        String prefix = "REQ-" + LocalDate.now(NUMBERING_ZONE).format(DateTimeFormatter.BASIC_ISO_DATE) + "-";
        HrRequest last = hrRequestMapper.selectOne(new LambdaQueryWrapper<HrRequest>()
                .likeRight(HrRequest::getRequestNo, prefix)
                .orderByDesc(HrRequest::getRequestNo)
                .last("LIMIT 1"));
        int next = last == null ? 1 : Integer.parseInt(last.getRequestNo().substring(prefix.length())) + 1;
        return prefix + String.format("%04d", next);
    }
}
