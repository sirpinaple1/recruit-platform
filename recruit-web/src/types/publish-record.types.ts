import { z } from 'zod';

/**
 * 发布台账类型与 Zod schema。
 * 后端契约（PublishRecordController / PublishRecordVO）：IPage 分页，
 * 可按 requestId / channelId / status 筛选。
 */

export const PublishRecordStatusSchema = z.enum(['pending', 'published', 'failed']);
export type PublishRecordStatus = z.infer<typeof PublishRecordStatusSchema>;

export const PublishRecordVOSchema = z.object({
  id: z.string(),
  draftId: z.string().nullable(),
  requestId: z.string().nullable(),
  requestNo: z.string().nullable(),
  requestTitle: z.string().nullable(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  status: PublishRecordStatusSchema,
  accountLabel: z.string().nullable(),
  publishedUrl: z.string().nullable(),
  resultNote: z.string().nullable(),
  operatedBy: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type PublishRecordVO = z.infer<typeof PublishRecordVOSchema>;

export const PublishRecordPageSchema = z.object({
  records: z.array(PublishRecordVOSchema),
  total: z.number(),
  size: z.number(),
  current: z.number(),
});
export type PublishRecordPage = z.infer<typeof PublishRecordPageSchema>;

// ---------- 展示标签 ----------

export const PUBLISH_RECORD_STATUS_LABELS: Record<PublishRecordStatus, string> = {
  pending: '待发布',
  published: '已发布',
  failed: '失败',
};
