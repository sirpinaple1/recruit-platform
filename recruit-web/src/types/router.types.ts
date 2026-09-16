import 'vue-router';

import { type UserRole } from './auth.types';

/**
 * 路由 meta 契约扩展（见 ADR-001）。
 *
 * role 缺省 = 任意已登录用户可访问；配置后仅列出的角色可进入。
 * 注意：后端才是授权权威，此处仅用于隐藏无权入口、避免展示必然 403 的页面。
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** 允许访问的角色，缺省表示不限制 */
    role?: readonly UserRole[];
  }
}
