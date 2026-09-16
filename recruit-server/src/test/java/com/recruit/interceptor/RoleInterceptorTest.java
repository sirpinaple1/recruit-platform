package com.recruit.interceptor;

import com.recruit.common.RequireRole;
import com.recruit.common.Roles;
import com.recruit.entity.SysUser;
import com.recruit.service.UserService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.method.HandlerMethod;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 角色授权拦截器测试（见 ADR-001）。
 *
 * <p>覆盖四类判定与两条边界：</p>
 * <ol>
 *   <li>未标注 {@link RequireRole}：登录态即放行（授权由本拦截器覆盖，不是默认拒绝）；</li>
 *   <li>角色命中：放行并挂载 {@code role} 属性（供后续复用，避免重复查库）；</li>
 *   <li>角色不命中：403；</li>
 *   <li>账号停用：403（AuthInterceptor 只验签，无法感知停用，这里是唯一的实时闸口）；</li>
 *   <li>方法级注解优先于类级（类级 ADMIN + 方法级 HR 时，HR 必须能进）；</li>
 *   <li>非 HandlerMethod（静态资源）：不校验。</li>
 * </ol>
 */
class RoleInterceptorTest {

    private static final Long USER_ID = 9001L;

    /** 类级 ADMIN；其中一个方法覆写为 HR/INTERVIEWER 可访问 */
    @RequireRole(Roles.ADMIN)
    static class AdminOnlyController {
        public void adminAction() {
            // 仅用于提供 HandlerMethod
        }

        @RequireRole({Roles.HR, Roles.INTERVIEWER})
        public void methodLevelOverride() {
            // 仅用于提供 HandlerMethod
        }
    }

    /** 未标注注解：仅要求登录态 */
    static class OpenController {
        public void openAction() {
            // 仅用于提供 HandlerMethod
        }
    }

    @Test
    @DisplayName("未标注 @RequireRole：登录态即满足，直接放行")
    void passesWhenNoAnnotation() throws Exception {
        MockHttpServletRequest request = loggedIn();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("HR").preHandle(request, response, handler(new OpenController(), "openAction"));

        assertThat(allowed).isTrue();
        assertThat(response.getStatus()).isEqualTo(200);
    }

    @Test
    @DisplayName("类级 @RequireRole(ADMIN) + ADMIN 用户：放行并挂载 role 属性")
    void passesWhenRoleMatchesClassLevel() throws Exception {
        MockHttpServletRequest request = loggedIn();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("ADMIN").preHandle(request, response, handler(new AdminOnlyController(), "adminAction"));

        assertThat(allowed).isTrue();
        assertThat(request.getAttribute("role"))
                .as("角色挂到 request 供 Controller/Service 复用，避免重复查库")
                .isEqualTo("ADMIN");
    }

    @Test
    @DisplayName("类级 @RequireRole(ADMIN) + HR 用户：403 拒绝")
    void rejectsWhenRoleMismatches() throws Exception {
        MockHttpServletRequest request = loggedIn();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("HR").preHandle(request, response, handler(new AdminOnlyController(), "adminAction"));

        assertThat(allowed).isFalse();
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(response.getContentAsString()).as("响应体是统一 R 结构").contains("\"code\":403");
    }

    @Test
    @DisplayName("方法级注解优先于类级：类级 ADMIN + 方法级 HR/INTERVIEWER 时 HR 可进")
    void methodLevelAnnotationOverridesClassLevel() throws Exception {
        MockHttpServletRequest request = loggedIn();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("HR").preHandle(request, response,
                handler(new AdminOnlyController(), "methodLevelOverride"));

        assertThat(allowed).as("HR 若被类级 ADMIN 挡住，说明方法级优先级没生效").isTrue();
    }

    @Test
    @DisplayName("方法级 @RequireRole(HR,INTERVIEWER)：INTERVIEWER 也可进（OR 语义，命中任一即放行）")
    void anyRoleInAnnotationGrantsAccess() throws Exception {
        MockHttpServletRequest request = loggedIn();

        boolean allowed = interceptor("INTERVIEWER").preHandle(request, new MockHttpServletResponse(),
                handler(new AdminOnlyController(), "methodLevelOverride"));

        assertThat(allowed).isTrue();
    }

    @Test
    @DisplayName("账号停用：即便角色命中，也立即 403（既有 token 不被信任）")
    void rejectsInactiveAccount() throws Exception {
        MockHttpServletRequest request = loggedIn();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("ADMIN", "inactive").preHandle(request, response,
                handler(new AdminOnlyController(), "adminAction"));

        assertThat(allowed).isFalse();
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(response.getContentAsString()).contains("停用");
    }

    @Test
    @DisplayName("账号停用：未标注 @RequireRole 的端点同样 403（停用是会话失效，与注解无关）")
    void rejectsInactiveAccountOnNonAnnotatedEndpoint() throws Exception {
        MockHttpServletRequest request = loggedIn();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("HR", "inactive").preHandle(request, response,
                handler(new OpenController(), "openAction"));

        assertThat(allowed)
                .as("早期实现先判注解、无注解即放行，导致停用账号仍能调需求单 CRUD——这正是本用例守住的缺口")
                .isFalse();
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(response.getContentAsString()).contains("停用");
    }

    @Test
    @DisplayName("未标注 @RequireRole 的端点也会挂载 role 属性（供下游免二次查库）")
    void mountsRoleOnNonAnnotatedEndpoint() throws Exception {
        MockHttpServletRequest request = loggedIn();

        boolean allowed = interceptor("HR").preHandle(request, new MockHttpServletResponse(),
                handler(new OpenController(), "openAction"));

        assertThat(allowed).isTrue();
        assertThat(request.getAttribute("role")).isEqualTo("HR");
    }

    @Test
    @DisplayName("缺少登录态（userId 属性缺失）：401")
    void rejectsWithoutLogin() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("ADMIN").preHandle(request, response, handler(new AdminOnlyController(), "adminAction"));

        assertThat(allowed).isFalse();
        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    @DisplayName("非 HandlerMethod（静态资源等）：不校验，直接放行")
    void passesNonHandlerMethod() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();

        boolean allowed = interceptor("HR").preHandle(request, response, "some-static-resource");

        assertThat(allowed).isTrue();
    }

    @Test
    @DisplayName("403/401 响应带 JSON 内容类型与 UTF-8 编码（中文提示不乱码）")
    void rejectResponseIsJsonUtf8() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();

        interceptor("HR").preHandle(loggedIn(), response, handler(new AdminOnlyController(), "adminAction"));

        assertThat(response.getContentType()).contains("application/json");
        assertThat(response.getCharacterEncoding()).isEqualToIgnoringCase("UTF-8");
    }

    // ==================== helpers ====================

    private RoleInterceptor interceptor(String role) {
        return interceptor(role, "active");
    }

    /** 角色与状态来自 DB（mock 的 UserService），而非 JWT/request——这正是本拦截器的设计要点 */
    private RoleInterceptor interceptor(String role, String status) {
        SysUser user = new SysUser();
        user.setId(USER_ID);
        user.setRole(role);
        user.setStatus(status);
        UserService userService = mock(UserService.class);
        when(userService.getById(USER_ID)).thenReturn(user);
        return new RoleInterceptor(userService);
    }

    /** 造一个带 userId 的已登录请求（角色不放在 request 上，由拦截器回查 DB） */
    private MockHttpServletRequest loggedIn() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setAttribute("userId", USER_ID);
        return request;
    }

    private HandlerMethod handler(Object bean, String methodName) throws NoSuchMethodException {
        return new HandlerMethod(bean, bean.getClass().getMethod(methodName));
    }
}
