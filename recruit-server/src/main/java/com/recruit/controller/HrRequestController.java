package com.recruit.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.recruit.common.R;
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
 * 人力需求单 CRUD（状态流转接口见 T2.2）
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/hr-requests")
public class HrRequestController {

    private final HrRequestService hrRequestService;

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
}
