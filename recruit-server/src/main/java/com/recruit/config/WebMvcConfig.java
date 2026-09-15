package com.recruit.config;

import com.recruit.interceptor.AuthInterceptor;
import com.recruit.interceptor.ExtensionAuthInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * MVC 配置：登录态拦截 + 扩展端独立鉴权
 */
@RequiredArgsConstructor
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;
    private final ExtensionAuthInterceptor extensionAuthInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                // 登录、健康检查、扩展端（独立 token 鉴权）不走登录态
                .excludePathPatterns("/api/auth/login", "/api/health", "/api/ext/**");
        // 扩展端：X-Extension-Token 独立鉴权（§6.2）
        registry.addInterceptor(extensionAuthInterceptor)
                .addPathPatterns("/api/ext/**");
    }
}
