package com.recruit.interceptor;

import com.alibaba.fastjson2.JSON;
import com.recruit.common.R;
import com.recruit.entity.ExtensionToken;
import com.recruit.service.ExtensionTokenService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.servlet.HandlerInterceptor;

import java.nio.charset.StandardCharsets;

/**
 * 扩展端独立鉴权拦截器（见设计文档 §6.2）：
 * 请求头 X-Extension-Token: &lt;token&gt; -&gt; SHA-256 命中且 active 放行（并刷 last_used_at），
 * 否则 401。通过后挂 extUserId 供 Controller 记录 operated_by，
 * 并挂 extTokenId 供采集审计记录授权来源（token 泄露时用于溯源定位到具体授权）。
 */
@RequiredArgsConstructor
@Component
public class ExtensionAuthInterceptor implements HandlerInterceptor {

    public static final String HEADER = "X-Extension-Token";

    private final ExtensionTokenService extensionTokenService;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        // CORS 预检（OPTIONS）按规范不携带鉴权头，交给 Spring MVC 的 PreFlight 处理返回 CORS 头。
        // 不拦截预检：否则浏览器连正式请求都不会发出，扩展侧只能看到一句 Failed to fetch。
        if (HttpMethod.OPTIONS.matches(request.getMethod())) {
            return true;
        }
        String token = request.getHeader(HEADER);
        if (!StringUtils.hasText(token)) {
            return reject(response);
        }
        ExtensionToken verified = extensionTokenService.verify(token);
        if (verified == null) {
            return reject(response);
        }
        request.setAttribute("extUserId", verified.getUserId());
        request.setAttribute("extTokenId", verified.getId());
        return true;
    }

    private boolean reject(HttpServletResponse response) throws Exception {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(JSON.toJSONString(R.fail(401, "扩展 token 无效或已吊销")));
        return false;
    }
}
