package com.recruit.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.recruit.common.R;
import com.recruit.dto.AiJdRequestDTO;
import com.recruit.dto.HrRequestCloseDTO;
import com.recruit.dto.HrRequestHeadcountDTO;
import com.recruit.dto.HrRequestRejectDTO;
import com.recruit.dto.HrRequestSaveDTO;
import com.recruit.service.AiServiceClient;
import com.recruit.service.HrRequestService;
import com.recruit.vo.AiJdResultVO;
import com.recruit.vo.HrRequestVO;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 人力需求单 CRUD 与状态机
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/hr-requests")
public class HrRequestController {

    private final HrRequestService hrRequestService;
    private final AiServiceClient aiServiceClient;

    // ==================== CRUD ====================

    /** 建单（draft） */
    @PostMapping
    public R<HrRequestVO> create(@Valid @RequestBody HrRequestSaveDTO dto, HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        return R.ok(hrRequestService.create(dto, userId));
    }

    /** 分页列表（可按状态筛选） */
    @GetMapping
    public R<IPage<HrRequestVO>> page(@RequestParam(defaultValue = "1") long page,
                                     @RequestParam(defaultValue = "10") long size,
                                     @RequestParam(required = false) String status) {
        return R.ok(hrRequestService.page(page, size, status));
    }

    /** 详情 */
    @GetMapping("/{id}")
    public R<HrRequestVO> detail(@PathVariable Long id) {
        return R.ok(hrRequestService.getById(id));
    }

    /** 编辑（仅 draft） */
    @PutMapping("/{id}")
    public R<HrRequestVO> update(@PathVariable Long id, @Valid @RequestBody HrRequestSaveDTO dto) {
        return R.ok(hrRequestService.update(id, dto));
    }

    // ==================== 状态机 ====================
    // 每个动作都把当前登录用户作为 operatorId 传下去：状态转移会据此写 domain_event，
    // 事件没有操作人就失去了审计价值（P1-2）。

    /** 提交审批：draft -> pending_approval */
    @PostMapping("/{id}/submit")
    public R<HrRequestVO> submit(@PathVariable Long id, HttpServletRequest request) {
        return R.ok(hrRequestService.submit(id, currentUserId(request)));
    }

    /** 审批通过：pending_approval -> open */
    @PostMapping("/{id}/approve")
    public R<HrRequestVO> approve(@PathVariable Long id, HttpServletRequest request) {
        return R.ok(hrRequestService.approve(id, currentUserId(request)));
    }

    /** 驳回：pending_approval -> draft */
    @PostMapping("/{id}/reject")
    public R<HrRequestVO> reject(@PathVariable Long id, @Valid @RequestBody HrRequestRejectDTO dto,
                                 HttpServletRequest request) {
        return R.ok(hrRequestService.reject(id, dto.getRejectReason(), currentUserId(request)));
    }

    /** 关闭：open -> closed */
    @PostMapping("/{id}/close")
    public R<HrRequestVO> close(@PathVariable Long id, @Valid @RequestBody HrRequestCloseDTO dto,
                                HttpServletRequest request) {
        return R.ok(hrRequestService.close(id, dto.getCloseReason(), currentUserId(request)));
    }

    /** 重新打开：closed -> draft */
    @PostMapping("/{id}/reopen")
    public R<HrRequestVO> reopen(@PathVariable Long id, HttpServletRequest request) {
        return R.ok(hrRequestService.reopen(id, currentUserId(request)));
    }

    /** 手动修正已入职数（触发 auto_close 判定） */
    @PostMapping("/{id}/headcount")
    public R<HrRequestVO> headcount(@PathVariable Long id, @Valid @RequestBody HrRequestHeadcountDTO dto,
                                    HttpServletRequest request) {
        return R.ok(hrRequestService.updateHeadcount(id, dto.getHeadcountFilled(), currentUserId(request)));
    }

    // ==================== AI 辅助 ====================

    /**
     * 一键生成 JD：表单已填的岗位要素 + HR 补充的背景描述 → AI 产出 JD 正文与任职要求。
     * 不落库：结果由前端填回表单，HR 编辑确认后走原有保存流程。
     */
    @PostMapping("/jd/generate")
    public R<AiJdResultVO.DataBody> generateJd(@Valid @RequestBody AiJdRequestDTO dto) {
        return R.ok(aiServiceClient.generateJd(dto));
    }

    /** 登录态由 AuthInterceptor 保证，此处直接取挂载的 userId */
    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute("userId");
    }
}
