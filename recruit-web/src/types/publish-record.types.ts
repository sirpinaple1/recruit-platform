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
  /**
   * 平台侧岗位 ID（BOSS jobId）—— 需求单与平台岗位的映射键。
   * null = 该次发布还没建立映射（扩展未捕获到），需要人工绑定。
   */
  platformJobId: z.string().nullable(),
  /** auto 扩展自动捕获 / manual 人工绑定；null = 尚未绑定 */
  platformJobBindSource: z.string().nullable(),
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
