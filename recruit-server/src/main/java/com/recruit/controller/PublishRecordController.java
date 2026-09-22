package com.recruit.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.recruit.common.R;
import com.recruit.common.RequireRole;
import com.recruit.common.Roles;
import com.recruit.dto.PlatformJobBindDTO;
import com.recruit.service.PublishRecordService;
import com.recruit.vo.PublishRecordVO;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 发布台账查询与岗位关联（登录态，见设计文档 §6.1）：
 * 可按需求 / 渠道 / 状态筛选，分页；并可人工绑定平台岗位（路径 B）。
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

    /**
     * 人工绑定 / 更正 / 解除平台岗位映射（路径 B，A 的兜底）。
     *
     * <p>权限：ADMIN + HR。绑定结果会级联改写全库投递的归类，属于招聘流程的日常操作，
     * 不是管理员专属动作 —— 但也不对未来的 INTERVIEWER 开放（其角色定位是只读参与面试）。</p>
     *
     * <p>请求体 {@code platformJobId} 传空 = 解除绑定。绑定冲突（该岗位已被别的台账持有）返回 409。</p>
     */
    @PutMapping("/{id}/platform-job")
    @RequireRole({Roles.ADMIN, Roles.HR})
    public R<PublishRecordVO> bindPlatformJob(@PathVariable Long id,
                                              @Valid @RequestBody PlatformJobBindDTO dto,
                                              HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        return R.ok(publishRecordService.bindPlatformJob(id, dto.getPlatformJobId(), userId));
    }
}
