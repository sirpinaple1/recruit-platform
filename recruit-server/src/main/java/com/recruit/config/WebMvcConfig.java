package com.recruit.config;

import com.recruit.interceptor.AuthInterceptor;
import com.recruit.interceptor.ExtensionAuthInterceptor;
import com.recruit.interceptor.RoleInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
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

    /**
     * 扩展端接口的 CORS 放行。
     *
     * <p>背景：扩展的页面与 service worker 运行在 {@code chrome-extension://<id>} 源下，
     * 请求中台 API 属于跨域。此前整套设计的前提是「扩展声明了 host_permissions 就能绕过
     * CORS」（见 ExtensionSessionController 注释），于是后端一行 CORS 都没配 —— 一旦该
     * 权限没生效（例如改完 manifest 没重载扩展、或扩展从别的目录加载），扩展侧 fetch 直接
     * 抛 {@code Failed to fetch}，而服务端日志干干净净，极难定位。</p>
     *
     * <p>这里把 CORS 补上，跨域由服务端显式允许，不再依赖扩展权限是否生效：
     * <ul>
     *   <li>只放行扩展端接口 {@code /api/ext/**} 与换权接口 {@code /api/extension/**}；
     *       中台前端与 API 经 nginx 同源，本就不需要跨域。</li>
     *   <li>放行 {@code chrome-extension://*}：扩展 id 随机，无法逐个枚举；这些接口自身
     *       仍需有效的 {@code X-Extension-Token}（或登录态），放行 origin 不等于放行数据。</li>
     *   <li>允许自定义头 {@code X-Extension-Token}，否则预检会被拒。</li>
     * </ul>
     * Spring MVC 对预检 OPTIONS 直接返回 CORS 头，不会进入上面任一拦截器。</p>
     */
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        allowExtensionOrigin(registry, "/api/ext/**");
        allowExtensionOrigin(registry, "/api/extension/**");
    }

    private void allowExtensionOrigin(CorsRegistry registry, String pathPattern) {
        registry.addMapping(pathPattern)
                .allowedOriginPatterns(
                        "chrome-extension://*",
                        "http://localhost:*",
                        "http://127.0.0.1:*")
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("X-Extension-Token", "Authorization", "Content-Type")
                .maxAge(3600);
    }
}
