package com.recruit.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.recruit.common.R;
import com.recruit.service.PublishRecordService;
import com.recruit.vo.PublishRecordVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 发布台账查询（登录态，见设计文档 §6.1）：
 * 可按需求 / 渠道 / 状态筛选，分页。
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/publish-records")
public class PublishRecordController {

    private final PublishRecordService publishRecordService;

    /** 台账分页查询（requestId/channelId/status 筛选） */
    @GetMapping
    public R<IPage<PublishRecordVO>> page(@RequestParam(defaultValue = "1") long page,
                                          @RequestParam(defaultValue = "10") long size,
                                          @RequestParam(required = false) Long requestId,
                                          @RequestParam(required = false) Long channelId,
                                          @RequestParam(required = false) String status) {
        return R.ok(publishRecordService.page(page, size, requestId, channelId, status));
    }

    /** 单条台账详情 */
    @GetMapping("/{id}")
    public R<PublishRecordVO> detail(@PathVariable Long id) {
        return R.ok(publishRecordService.getDetail(id));
    }
}
