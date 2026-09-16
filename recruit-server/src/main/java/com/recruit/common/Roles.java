package com.recruit.common;

/**
 * 角色常量（取值与 sys_user.role、sys_dict.user_role 一致，见 ADR-001）。
 *
 * <p>一期启用 ADMIN / HR 两个角色；INTERVIEWER 待面试模块开工时启用。
 * 后端是授权权威，前端按角色隐藏入口仅作体验优化。</p>
 */
public final class Roles {

    /** 系统管理员：扩展授权签发/吊销、渠道增改等管理动作 */
    public static final String ADMIN = "ADMIN";

    /** 招聘负责人：需求单与渠道发布流程的日常操作 */
    public static final String HR = "HR";

    /** 面试官：一期未启用，预留 */
    public static final String INTERVIEWER = "INTERVIEWER";

    private Roles() {
    }
}
