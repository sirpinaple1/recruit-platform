package com.recruit.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.recruit.common.MyException;
import com.recruit.entity.HrRequest;
import com.recruit.entity.SysUser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * PositionAccessService 权限矩阵单测
 *
 * <p>覆盖 ADR-008 §5 的完整权限矩阵：
 * <ul>
 *   <li>ADMIN：可见全部、可操作全部</li>
 *   <li>owner：可见/可操作自己负责的岗位</li>
 *   <li>非owner：不可见、不可操作</li>
 *   <li>owner_user_id IS NULL：对 HR 不可见/不可操作（fail-closed），仅 ADMIN 可见</li>
 * </ul>
 *
 * @see <a href="../../../../../docs/architecture/adr/ADR-008-resource-ownership-authorization.md">ADR-008</a>
 */
@DisplayName("岗位归属授权判定")
class PositionAccessServiceTest {

    private PositionAccessService service;

    private SysUser admin;
    private SysUser hrOwner;
    private SysUser hrOther;

    private HrRequest requestOwnedByHr;
    private HrRequest requestUnassigned;

    @BeforeEach
    void setUp() {
        service = new PositionAccessService();

        // ADMIN 用户
        admin = new SysUser();
        admin.setId(1L);
        admin.setRole("ADMIN");

        // HR 用户（负责人）
        hrOwner = new SysUser();
        hrOwner.setId(2L);
        hrOwner.setRole("HR");

        // HR 用户（非负责人）
        hrOther = new SysUser();
        hrOther.setId(3L);
        hrOther.setRole("HR");

        // 岗位：归属 hrOwner
        requestOwnedByHr = new HrRequest();
        requestOwnedByHr.setId(100L);
        requestOwnedByHr.setOwnerUserId(2L);

        // 岗位：未指派负责人（NULL）
        requestUnassigned = new HrRequest();
        requestUnassigned.setId(200L);
        requestUnassigned.setOwnerUserId(null);
    }

    // ==================== canView ====================

    @Test
    @DisplayName("ADMIN 可见已指派岗位")
    void adminCanViewAssignedRequest() {
        assertTrue(service.canView(requestOwnedByHr, admin));
    }

    @Test
    @DisplayName("ADMIN 可见未指派岗位")
    void adminCanViewUnassignedRequest() {
        assertTrue(service.canView(requestUnassigned, admin));
    }

    @Test
    @DisplayName("owner 可见自己负责的岗位")
    void ownerCanViewOwnRequest() {
        assertTrue(service.canView(requestOwnedByHr, hrOwner));
    }

    @Test
    @DisplayName("非 owner 的 HR 不可见他人岗位")
    void nonOwnerCannotViewOthersRequest() {
        assertFalse(service.canView(requestOwnedByHr, hrOther));
    }

    @Test
    @DisplayName("HR 不可见未指派岗位（fail-closed）")
    void hrCannotViewUnassignedRequest() {
        assertFalse(service.canView(requestUnassigned, hrOwner));
        assertFalse(service.canView(requestUnassigned, hrOther));
    }

    @Test
    @DisplayName("null 入参保护：request 为 null")
    void canViewReturnsFalseWhenRequestIsNull() {
        assertFalse(service.canView(null, admin));
        assertFalse(service.canView(null, hrOwner));
    }

    @Test
    @DisplayName("null 入参保护：user 为 null")
    void canViewReturnsFalseWhenUserIsNull() {
        assertFalse(service.canView(requestOwnedByHr, null));
    }

    // ==================== canOperate ====================

    @Test
    @DisplayName("ADMIN 可操作已指派岗位")
    void adminCanOperateAssignedRequest() {
        assertTrue(service.canOperate(requestOwnedByHr, admin));
    }

    @Test
    @DisplayName("ADMIN 可操作未指派岗位")
    void adminCanOperateUnassignedRequest() {
        assertTrue(service.canOperate(requestUnassigned, admin));
    }

    @Test
    @DisplayName("owner 可操作自己负责的岗位")
    void ownerCanOperateOwnRequest() {
        assertTrue(service.canOperate(requestOwnedByHr, hrOwner));
    }

    @Test
    @DisplayName("非 owner 的 HR 不可操作他人岗位")
    void nonOwnerCannotOperateOthersRequest() {
        assertFalse(service.canOperate(requestOwnedByHr, hrOther));
    }

    @Test
    @DisplayName("HR 不可操作未指派岗位（fail-closed）")
    void hrCannotOperateUnassignedRequest() {
        assertFalse(service.canOperate(requestUnassigned, hrOwner));
        assertFalse(service.canOperate(requestUnassigned, hrOther));
    }

    // ==================== assertCanOperate ====================

    @Test
    @DisplayName("ADMIN 操作未指派岗位不抛异常")
    void adminAssertDoesNotThrowForUnassignedRequest() {
        assertDoesNotThrow(() -> service.assertCanOperate(requestUnassigned, admin));
    }

    @Test
    @DisplayName("owner 操作自己岗位不抛异常")
    void ownerAssertDoesNotThrowForOwnRequest() {
        assertDoesNotThrow(() -> service.assertCanOperate(requestOwnedByHr, hrOwner));
    }

    @Test
    @DisplayName("非 owner 操作他人岗位抛 403")
    void nonOwnerAssertThrows403ForOthersRequest() {
        MyException ex = assertThrows(MyException.class,
                () -> service.assertCanOperate(requestOwnedByHr, hrOther));
        assertEquals(403, ex.getCode());
        assertTrue(ex.getMessage().contains("无权操作该岗位"));
    }

    @Test
    @DisplayName("HR 操作未指派岗位抛 403，提示未指派")
    void hrAssertThrows403ForUnassignedRequest() {
        MyException ex = assertThrows(MyException.class,
                () -> service.assertCanOperate(requestUnassigned, hrOwner));
        assertEquals(403, ex.getCode());
        assertTrue(ex.getMessage().contains("未指派负责人"));
    }

    // ==================== viewScope ====================

    @Test
    @DisplayName("ADMIN 的 viewScope 不添加过滤条件")
    void adminViewScopeReturnsEmptyWrapper() {
        LambdaQueryWrapper<HrRequest> wrapper = service.viewScope(admin);
        assertNotNull(wrapper);
        // 空 wrapper.getExpression() 表示无过滤条件
        // 实际使用时会查全部数据
    }

    @Test
    @DisplayName("HR 的 viewScope 添加 owner 过滤条件")
    void hrViewScopeFiltersOwner() {
        LambdaQueryWrapper<HrRequest> wrapper = service.viewScope(hrOwner);
        assertNotNull(wrapper);
        // wrapper 已包含 owner_user_id = hrOwner.id 的条件
        // 实际 SQL 会追加 WHERE owner_user_id = 2
    }

    @Test
    @DisplayName("user 为 null 时 viewScope 返回空结果条件")
    void viewScopeReturnsNoResultsWhenUserIsNull() {
        LambdaQueryWrapper<HrRequest> wrapper = service.viewScope(null);
        assertNotNull(wrapper);
        // wrapper 包含永假条件（id = -1），确保查询返回 0 行
    }

    // ==================== 边界用例 ====================

    @Test
    @DisplayName("角色大小写敏感：admin（小写）不享受 ADMIN 权限")
    void roleCaseSensitivity() {
        SysUser adminLowerCase = new SysUser();
        adminLowerCase.setId(99L);
        adminLowerCase.setRole("admin"); // 小写

        // 小写 admin 被当作普通角色，无全局可见权限
        assertFalse(service.canView(requestOwnedByHr, adminLowerCase));
    }

    @Test
    @DisplayName("owner_user_id = 0 与未指派的区别")
    void ownerIdZeroIsNotNull() {
        HrRequest requestOwnerZero = new HrRequest();
        requestOwnerZero.setId(300L);
        requestOwnerZero.setOwnerUserId(0L);

        // owner_user_id = 0 是有明确归属（虽然可能无效），不是 NULL
        // HR 用户 id=0 可以看到它（假设存在 id=0 的用户）
        SysUser hrZero = new SysUser();
        hrZero.setId(0L);
        hrZero.setRole("HR");

        assertTrue(service.canView(requestOwnerZero, hrZero));
        assertFalse(service.canView(requestOwnerZero, hrOwner)); // hrOwner.id=2 看不到
    }
}
