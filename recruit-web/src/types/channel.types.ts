import { z } from 'zod';

/**
 * 渠道注册表类型与 Zod schema。
 * 后端契约（ChannelController / ChannelVO）：
 * - id 为雪花 ID，后端序列化为字符串（防 JS 丢精度）
 * - fieldMapJson 后端输出为 JSON 对象（非转义字符串）
 */

export const ChannelCapabilitySchema = z.enum(['manual', 'api', 'connector', 'rpa']);
export type ChannelCapability = z.infer<typeof ChannelCapabilitySchema>;

export const ChannelStatusSchema = z.enum(['enabled', 'disabled']);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const ChannelVOSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  publishUrlPattern: z.string().nullable(),
  fieldMapJson: z.record(z.string(), z.unknown()).nullable(),
  deepLinkTemplate: z.string().nullable(),
  capability: ChannelCapabilitySchema,
  status: ChannelStatusSchema,
  sortOrder: z.number().int(),
  remark: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChannelVO = z.infer<typeof ChannelVOSchema>;

/** 新建 / 编辑载荷（fieldMapJson 为 JSON 字符串，后端做合法性校验与规范化） */
export const ChannelSavePayloadSchema = z.object({
  code: z.string().trim().min(1, '渠道代码不能为空').max(32, '渠道代码不能超过 32 字'),
  name: z.string().trim().min(1, '渠道名称不能为空').max(64, '渠道名称不能超过 64 字'),
  publishUrlPattern: z.string().max(512).nullable(),
  fieldMapJson: z.string().min(1, '字段映射配置不能为空'),
  deepLinkTemplate: z.string().max(512).nullable(),
  capability: ChannelCapabilitySchema.nullable(),
  status: ChannelStatusSchema.nullable(),
  sortOrder: z.number().int().min(0).nullable(),
  remark: z.string().max(256).nullable(),
});
export type ChannelSavePayload = z.infer<typeof ChannelSavePayloadSchema>;

// ---------- 展示标签 ----------

export const CAPABILITY_LABELS: Record<ChannelCapability, string> = {
  manual: '手工发布',
  api: 'API 对接',
  connector: '连接器',
  rpa: 'RPA',
};

export const CAPABILITY_OPTIONS: ReadonlyArray<{ value: ChannelCapability; label: string }> = [
  { value: 'manual', label: '手工发布' },
  { value: 'api', label: 'API 对接' },
  { value: 'connector', label: '连接器' },
  { value: 'rpa', label: 'RPA' },
];

export const CHANNEL_STATUS_LABELS: Record<ChannelStatus, string> = {
  enabled: '启用',
  disabled: '停用',
};
