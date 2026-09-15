package com.recruit.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.recruit.common.R;
import com.recruit.dto.HrRequestCloseDTO;
import com.recruit.dto.HrRequestHeadcountDTO;
import com.recruit.dto.HrRequestRejectDTO;
import com.recruit.dto.HrRequestSaveDTO;
import com.recruit.service.HrRequestService;
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

    /** 提交审批：draft -> pending_approval */
    @PostMapping("/{id}/submit")
    public R<HrRequestVO> submit(@PathVariable Long id) {
        return R.ok(hrRequestService.submit(id));
    }

    /** 审批通过：pending_approval -> open */
    @PostMapping("/{id}/approve")
    public R<HrRequestVO> approve(@PathVariable Long id) {
        return R.ok(hrRequestService.approve(id));
    }

    /** 驳回：pending_approval -> draft */
    @PostMapping("/{id}/reject")
    public R<HrRequestVO> reject(@PathVariable Long id, @Valid @RequestBody HrRequestRejectDTO dto) {
        return R.ok(hrRequestService.reject(id, dto.getRejectReason()));
    }

    /** 关闭：open -> closed */
    @PostMapping("/{id}/close")
    public R<HrRequestVO> close(@PathVariable Long id, @Valid @RequestBody HrRequestCloseDTO dto) {
        return R.ok(hrRequestService.close(id, dto.getCloseReason()));
    }

    /** 重新打开：closed -> draft */
    @PostMapping("/{id}/reopen")
    public R<HrRequestVO> reopen(@PathVariable Long id) {
        return R.ok(hrRequestService.reopen(id));
    }

    /** 手动修正已入职数（触发 auto_close 判定） */
    @PostMapping("/{id}/headcount")
    public R<HrRequestVO> headcount(@PathVariable Long id, @Valid @RequestBody HrRequestHeadcountDTO dto) {
        return R.ok(hrRequestService.updateHeadcount(id, dto.getHeadcountFilled()));
    }
}
