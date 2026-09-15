import { createRouter, createWebHistory } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

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
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

// 登录态守卫：无 token 一律去登录页；已登录访问登录页回工作台
router.beforeEach((to) => {
  const { isLoggedIn } = useAuthStore();
  if (to.name !== 'login' && !isLoggedIn.value) {
    return { name: 'login' };
  }
  if (to.name === 'login' && isLoggedIn.value) {
    return { name: 'workbench' };
  }
  return true;
});

export default router;
