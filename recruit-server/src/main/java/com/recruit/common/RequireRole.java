package com.recruit.common;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 角色授权注解，由 {@link com.recruit.interceptor.RoleInterceptor} 校验（见 ADR-001）。
 *
 * <p>标注在 Controller 类上对整类生效；标注在方法上只对该方法生效，
 * 且方法级优先于类级。未标注的端点仅要求登录态。</p>
 *
 * <p>value 为允许访问的角色集合，命中任一即放行（OR 语义）。
 * 默认值取最严的 ADMIN，避免漏写 value 时误放行。</p>
 *
 * <p>用法：{@code @RequireRole(Roles.ADMIN)}</p>
 */
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequireRole {

    /** 允许访问的角色，取值见 {@link Roles} */
    String[] value() default Roles.ADMIN;
}
