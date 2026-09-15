import { z } from 'zod';

/**
 * 登录相关类型与 Zod schema。
 * 后端契约（AuthController / LoginDTO / LoginVO）：
 * - POST /api/auth/login  body {username, password} → R<LoginVO>
 * - GET  /api/auth/me     Bearer JWT          → R<LoginVO>（无 token 字段）
 */

export const LoginPayloadSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(6, '密码至少 6 位'),
});
export type LoginPayload = z.infer<typeof LoginPayloadSchema>;

export const LoginVOSchema = z.object({
  /** 仅 /api/auth/login 返回；/me 显式返回 null（后端 Builder 未设值时 fastjson2 输出 null） */
  token: z.string().nullish(),
  id: z.number().int(),
  username: z.string(),
  realName: z.string(),
  role: z.enum(['ADMIN', 'HR', 'INTERVIEWER']),
});
export type LoginVO = z.infer<typeof LoginVOSchema>;
