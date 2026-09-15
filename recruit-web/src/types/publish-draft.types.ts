import { z } from 'zod';

/**
 * 发布草稿类型与 Zod schema。
 * 后端契约（PublishDraftController / PublishDraftVO）：
 * - fieldsJson 为渲染好的「白名单字段 -> 值」对象
 * - 草稿在需求审批通过时自动生成，关闭 / 重新生成时置 cancelled
 */

export const DraftStatusSchema = z.enum(['pending', 'consumed', 'cancelled']);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export const PublishDraftVOSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  channelId: z.string(),
  channelCode: z.string().nullable(),
  channelName: z.string().nullable(),
  publishUrlPattern: z.string().nullable(),
  fieldsJson: z.record(z.string(), z.unknown()).nullable(),
  deepLink: z.string().nullable(),
  status: DraftStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublishDraftVO = z.infer<typeof PublishDraftVOSchema>;

// ---------- 展示标签 ----------

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  pending: '待发布',
  consumed: '已发布',
  cancelled: '已取消',
};

/** fields_json 白名单字段的中文标签（渲染摘要展示用） */
export const FIELD_LABELS: Record<string, string> = {
  title: '职位名称',
  jobDescription: '职位描述',
  jobRequirement: '任职要求',
  location: '工作地点',
  salaryMin: '薪资下限',
  salaryMax: '薪资上限',
  salaryText: '薪资范围',
  education: '学历要求',
  experienceYears: '工作年限',
  employmentType: '用工性质',
};
