import { LoginVOSchema, type LoginPayload, type LoginVO } from '@/types/auth.types';

import { request } from '../httpClient';

/** 登录：成功返回含 JWT 的 LoginVO */
export function login(payload: LoginPayload): Promise<LoginVO> {
  return request<LoginVO>(
    { method: 'POST', url: '/auth/login', data: payload },
    LoginVOSchema,
  );
}

/** 当前登录用户信息（Bearer，token 失效抛 ApiError 401） */
export function fetchMe(): Promise<LoginVO> {
  return request<LoginVO>({ method: 'GET', url: '/auth/me' }, LoginVOSchema);
}
