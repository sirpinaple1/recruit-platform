package com.recruit.config;

import com.recruit.interceptor.AuthInterceptor;
import com.recruit.interceptor.ExtensionAuthInterceptor;
import com.recruit.interceptor.RoleInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * MVC 配置：登录态拦截 + 角色授权 + 扩展端独立鉴权
 *
 * <p>拦截器注册顺序即执行顺序：AuthInterceptor（认证）必须在 RoleInterceptor（授权）之前，
 * 后者依赖前者挂载的 userId 属性。</p>
 */
@RequiredArgsConstructor
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;
    private final RoleInterceptor roleInterceptor;
    private final ExtensionAuthInterceptor extensionAuthInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                // 登录、健康检查、扩展端（独立 token 鉴权）不走登录态
                .excludePathPatterns("/api/auth/login", "/api/health", "/api/ext/**");
        // 角色授权：仅校验标注了 @RequireRole 的端点（见 ADR-001）。
        // 排除路径必须与 authInterceptor 一致，否则扩展端会因取不到 userId 被误判 401。
        registry.addInterceptor(roleInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/login", "/api/health", "/api/ext/**");
        // 扩展端：X-Extension-Token 独立鉴权（§6.2）
        registry.addInterceptor(extensionAuthInterceptor)
                .addPathPatterns("/api/ext/**");
    }
}
