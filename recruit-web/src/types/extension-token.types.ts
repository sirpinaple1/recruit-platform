import { z } from 'zod';

/**
 * 扩展授权类型与 Zod schema。
 * 后端契约（ExtensionTokenController / VO）：
 * - 明文 token 仅创建响应返回一次，列表只含 hash 前缀（红线 §5.5：不落库不落日志）
 * - id 为雪花 ID，后端序列化为字符串（防 JS 丢精度）
 */

export const ExtensionTokenStatusSchema = z.enum(['active', 'revoked']);
export type ExtensionTokenStatus = z.infer<typeof ExtensionTokenStatusSchema>;

export const ExtensionTokenVOSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenHashPrefix: z.string().nullable(),
  status: ExtensionTokenStatusSchema,
  userName: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type ExtensionTokenVO = z.infer<typeof ExtensionTokenVOSchema>;

export const ExtensionTokenCreatedVOSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 一次性明文 token：仅创建响应出现，前端立即让用户保存 */
  token: z.string(),
  tokenHashPrefix: z.string().nullable(),
  userName: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type ExtensionTokenCreatedVO = z.infer<typeof ExtensionTokenCreatedVOSchema>;

// ---------- 展示标签 ----------

export const EXTENSION_TOKEN_STATUS_LABELS: Record<ExtensionTokenStatus, string> = {
  active: '生效中',
  revoked: '已吊销',
};
