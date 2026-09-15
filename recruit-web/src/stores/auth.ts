import { computed, ref } from 'vue';

import { LoginVOSchema, type LoginVO } from '@/types/auth.types';

/**
 * 登录态存储（模块级单例，composable 风格）。
 * token 持久化到 localStorage，刷新页面不掉登录态。
 */

export const TOKEN_KEY = 'recruit_token';
const USER_KEY = 'recruit_user';

function readCachedUser(): LoginVO | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const result = LoginVOSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const token = ref<string>(localStorage.getItem(TOKEN_KEY) ?? '');
const user = ref<LoginVO | null>(readCachedUser());

/** 清空登录态（httpClient 401 兜底也会调用） */
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  token.value = '';
  user.value = null;
}

export function useAuthStore() {
  const isLoggedIn = computed(() => token.value !== '');

  /** 登录成功：写入 token 与用户信息 */
  function login(vo: LoginVO): void {
    if (!vo.token) {
      throw new Error('登录响应缺少 token');
    }
    localStorage.setItem(TOKEN_KEY, vo.token);
    localStorage.setItem(USER_KEY, JSON.stringify(vo));
    token.value = vo.token;
    user.value = vo;
  }

  /** 用 /api/auth/me 的结果刷新用户信息 */
  function setUser(vo: LoginVO): void {
    localStorage.setItem(USER_KEY, JSON.stringify(vo));
    user.value = vo;
  }

  /** 登出 */
  function logout(): void {
    clearAuth();
  }

  return { token, user, isLoggedIn, login, setUser, logout };
}
