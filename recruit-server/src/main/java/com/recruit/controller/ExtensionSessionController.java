package com.recruit.controller;

import com.recruit.body.ExtensionSessionTokenBody;
import com.recruit.common.R;
import com.recruit.service.ExtensionTokenService;
import com.recruit.vo.ExtensionSessionTokenVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 扩展零配置授权（§4）：登录态换权接口。
 * 
 * POST /api/extension/session-token
 * - 由扩展 background 脚本通过 Chrome Extension API 调用（绕过 CORS）
 * - 从当前登录 session 获取 userId，签发或复用扩展 token
 * - 支持 token 复用机制，避免多设备互踢
 */
@RestController
@RequestMapping("/api/extension")
@RequiredArgsConstructor
public class ExtensionSessionController {

    private final ExtensionTokenService extensionTokenService;

    /**
     * 登录态换权：获取扩展 token
     * 
     * 请求体：{ "token": "xxx" }  // 可选，扩展本地已有的 token
     * 
     * 响应：
     * - 复用场景：{ "reused": true, "token": null, "tokenId": "123", "expiresAt": "..." }
     * - 新签发：  { "reused": false, "token": "xxx", "tokenId": "123", "expiresAt": "..." }
     */
    @PostMapping("/session-token")
    public R<ExtensionSessionTokenVO> getSessionToken(
            @RequestAttribute("userId") Long userId,
            @RequestBody(required = false) ExtensionSessionTokenBody body) {
        
        String oldToken = (body != null) ? body.getToken() : null;
        ExtensionSessionTokenVO result = extensionTokenService.resolveForSession(userId, oldToken);
        return R.ok(result);
    }
}
