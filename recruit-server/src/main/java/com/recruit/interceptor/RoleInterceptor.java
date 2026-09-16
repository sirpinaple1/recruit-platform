package com.recruit.interceptor;

import com.alibaba.fastjson2.JSON;
import com.recruit.common.R;
import com.recruit.common.RequireRole;
import com.recruit.entity.SysUser;
import com.recruit.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/**
 * 角色授权与账号在册校验（见 ADR-001）。
 *
 * <p><b>做两件事，且顺序不能颠倒</b>：</p>
 * <ol>
 *   <li><b>账号在册</b>——查库取用户，停用即 403。这一步与是否标注 {@link RequireRole} <b>无关</b>；
 *       停用意味着「会话失效」而不是「权限不足」，所以不能只在需要角色的端点上检查。</li>
 *   <li><b>角色命中</b>——仅在标注了 {@link RequireRole} 时比对（方法级优先于类级），不命中即 403。</li>
 * </ol>
 *
 * <p><b>为什么第 1 步必须先于第 2 步</b>：早期实现是「先看有没有注解，没有就直接放行」，
 * 于是未标注注解的端点（需求单 CRUD、列表、详情、渠道列表、台账查询等）对已停用账号
 * 的旧 token 依然开放——ADR-001 承诺的「账号停用立即生效」只对少数端点成立。
 * 现已把停用检查提到最前，代价是每个已认证请求多一次 {@code sys_user} 主键查询
 * （内部系统规模下可忽略；成为热点时的出路见 ADR-001 的 Redis 缓存提示）。</p>
 *
 * <p>非 {@link HandlerMethod}（静态资源、未映射路径等）直接放行：这不是 Controller 端点，
 * 登录态已由 {@link AuthInterceptor} 在更前面全量保证。</p>
 */
@RequiredArgsConstructor
@Component
public class RoleInterceptor implements HandlerInterceptor {

    private final UserService userService;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return true;
        }

        // ---- 第 1 步：账号在册（与注解无关，必须先做）----
        Long userId = (Long) request.getAttribute("userId");
        SysUser user = userId == null ? null : userService.getById(userId);
        if (user == null) {
            return reject(response, 401, "未登录或登录已过期");
        }
        if (!"active".equals(user.getStatus())) {
            return reject(response, 403, "账号已停用，请联系管理员");
        }
        // 挂载角色，供 Controller/Service 需要时读取，避免重复查库
        request.setAttribute("role", user.getRole());

        // ---- 第 2 步：角色命中（仅标注 @RequireRole 时）----
        RequireRole requireRole = resolveAnnotation(handlerMethod);
        if (requireRole == null) {
            return true;
        }
        List<String> allowed = Arrays.asList(requireRole.value());
        if (!allowed.contains(user.getRole())) {
            return reject(response, 403, "无权访问该功能（需要 " + String.join(" / ", allowed) + " 角色）");
        }
        return true;
    }

    /** 方法级注解优先于类级注解 */
    private RequireRole resolveAnnotation(HandlerMethod handlerMethod) {
        RequireRole onMethod = handlerMethod.getMethodAnnotation(RequireRole.class);
        return onMethod != null ? onMethod : handlerMethod.getBeanType().getAnnotation(RequireRole.class);
    }

    /** 与 AuthInterceptor 一致：返回真实 HTTP 状态码 + R 结构体 */
    private boolean reject(HttpServletResponse response, int code, String msg) throws Exception {
        response.setStatus(code);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(JSON.toJSONString(R.fail(code, msg)));
        return false;
    }
}
