package com.recruit.controller;

import com.recruit.common.R;
import com.recruit.dto.ExtensionTokenCreateDTO;
import com.recruit.service.ExtensionTokenService;
import com.recruit.vo.ExtensionTokenCreatedVO;
import com.recruit.vo.ExtensionTokenVO;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 扩展授权管理（登录态，见设计文档 §6.1）：
 * 明文 token 仅创建响应返回一次（红线 §5.5：不落库不落日志）。
 */
@RequiredArgsConstructor
@RestController
@RequestMapping("/api/extension-tokens")
public class ExtensionTokenController {

    private final ExtensionTokenService extensionTokenService;

    /** 生成授权：响应含一次性明文 token */
    @PostMapping
    public R<ExtensionTokenCreatedVO> create(@Valid @RequestBody ExtensionTokenCreateDTO dto,
                                             HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        return R.ok(extensionTokenService.create(dto.getName(), userId));
    }

    /** 列表：只展示 hash 前缀与元数据 */
    @GetMapping
    public R<List<ExtensionTokenVO>> list() {
        return R.ok(extensionTokenService.list());
    }

    /** 吊销：吊销后扩展端请求立即 401 */
    @PostMapping("/{id}/revoke")
    public R<ExtensionTokenVO> revoke(@PathVariable Long id) {
        return R.ok(extensionTokenService.revoke(id));
    }
}
