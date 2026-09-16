import { createRouter, createWebHistory } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import '@/types/router.types';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/pages/login/LoginPage.vue'),
    },
    {
      path: '/',
      name: 'workbench',
      component: () => import('@/pages/WorkbenchPage.vue'),
    },
    {
      path: '/hr-requests',
      name: 'hr-requests',
      component: () => import('@/pages/hr-requests/HrRequestListPage.vue'),
    },
    {
      path: '/hr-requests/:id',
      name: 'hr-request-detail',
      component: () => import('@/pages/hr-requests/HrRequestDetailPage.vue'),
    },
    {
      // 渠道配置含写操作（后端收敛 ADMIN），整页限管理员
      path: '/channels',
      name: 'channels',
      meta: { role: ['ADMIN'] },
      component: () => import('@/pages/channels/ChannelListPage.vue'),
    },
    {
      path: '/publish-records',
      name: 'publish-records',
      component: () => import('@/pages/publish-records/PublishRecordListPage.vue'),
    },
    {
      // 扩展授权可访问全量待发布草稿，限管理员
      path: '/extension-tokens',
      name: 'extension-tokens',
      meta: { role: ['ADMIN'] },
      component: () => import('@/pages/extension-tokens/ExtensionTokenListPage.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

// 守卫：先校验登录态，再校验角色。
// 无 token 一律去登录页；已登录访问登录页回工作台；角色不足退回工作台。
router.beforeEach((to) => {
  const { isLoggedIn, user } = useAuthStore();
  if (to.name !== 'login' && !isLoggedIn.value) {
    return { name: 'login' };
  }
  if (to.name === 'login' && isLoggedIn.value) {
    return { name: 'workbench' };
  }
  // 角色守卫：后端是授权权威，前端仅避免展示必然 403 的页面
  const allowed = to.meta.role;
  if (allowed && allowed.length > 0) {
    const role = user.value?.role;
    if (!role || !allowed.includes(role)) {
      console.warn(`无权限访问 ${String(to.name)}，需要角色 ${allowed.join('/')}`);
      return { name: 'workbench' };
    }
  }
  return true;
});

export default router;
