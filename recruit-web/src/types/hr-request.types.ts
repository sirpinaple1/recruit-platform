import { z } from 'zod';

/**
 * 人力需求单相关类型与 Zod schema。
 * 后端契约（HrRequestController / HrRequestVO）：
 * - id / createdBy 为雪花 ID，后端序列化为字符串（防 JS 丢精度）
 * - 时间为 UTC ISO 字符串（如 2026-09-15T13:59:35.956）
 */

export const HrRequestStatusSchema = z.enum(['draft', 'pending_approval', 'open', 'closed']);
export type HrRequestStatus = z.infer<typeof HrRequestStatusSchema>;

export const HrRequestVOSchema = z.object({
  id: z.string(),
  requestNo: z.string(),
  title: z.string(),
  deptName: z.string(),
  headcountTotal: z.number().int(),
  headcountFilled: z.number().int(),
  jobDescription: z.string(),
  jobRequirement: z.string().nullable(),
  salaryMin: z.number().int().nullable(),
  salaryMax: z.number().int().nullable(),
  location: z.string().nullable(),
  education: z.string().nullable(),
  experienceYears: z.number().int().nullable(),
  employmentType: z.string().nullable(),
  status: HrRequestStatusSchema,
  closeReason: z.string().nullable(),
  autoClose: z.boolean(),
  rejectReason: z.string().nullable(),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrRequestVO = z.infer<typeof HrRequestVOSchema>;

/** 分页响应（MyBatis-Plus Page 结构，多余字段被 Zod 剥离） */
export const HrRequestPageSchema = z.object({
  records: z.array(HrRequestVOSchema),
  total: z.number(),
  size: z.number(),
  current: z.number(),
  pages: z.number(),
});
export type HrRequestPage = z.infer<typeof HrRequestPageSchema>;

export const EmploymentTypeSchema = z.enum(['full_time', 'part_time', 'internship', 'contract']);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

/**
 * 建单 / 编辑载荷。
 * 必填对齐渠道发布页（BOSS）必填项：经验 / 学历 / 薪资范围不可为空——
 * 缺值会渲染出残缺草稿，渠道填充必然失败。
 */
export const HrRequestSavePayloadSchema = z.object({
  title: z.string().min(1, '岗位名称不能为空').max(128, '岗位名称不能超过 128 字'),
  deptName: z.string().min(1, '用人部门不能为空').max(64, '用人部门不能超过 64 字'),
  headcountTotal: z.number().int().min(1, '招聘人数至少为 1'),
  jobDescription: z
    .string()
    .min(30, 'JD 描述过于简短（至少 30 字）：描述越具体，发布时渠道的职位类型推荐越准确'),
  jobRequirement: z.string().max(65535).nullable(),
  salaryMin: z
    .number({ invalid_type_error: '薪资范围（下限）不能为空' })
    .int()
    .min(0, '薪资下限不能为负数'),
  salaryMax: z
    .number({ invalid_type_error: '薪资范围（上限）不能为空' })
    .int()
    .min(0, '薪资上限不能为负数'),
  location: z.string().max(128).nullable(),
  education: z
    .string({ invalid_type_error: '学历要求不能为空' })
    .min(1, '学历要求不能为空')
    .max(32),
  experienceYears: z
    .number({ invalid_type_error: '要求工作年限不能为空' })
    .int()
    .min(0, '工作年限不能为负数'),
  employmentType: EmploymentTypeSchema.nullable(),
  autoClose: z.boolean().nullable(),
});
export type HrRequestSavePayload = z.infer<typeof HrRequestSavePayloadSchema>;

export const RejectPayloadSchema = z.object({
  rejectReason: z.string().min(1, '驳回原因不能为空').max(256, '驳回原因不能超过 256 字'),
});
export type RejectPayload = z.infer<typeof RejectPayloadSchema>;

export const ClosePayloadSchema = z.object({
  closeReason: z.enum(['filled', 'cancelled', 'frozen']),
});
export type ClosePayload = z.infer<typeof ClosePayloadSchema>;

export const HeadcountPayloadSchema = z.object({
  headcountFilled: z.number().int().min(0, '已入职数不能为负数'),
});
export type HeadcountPayload = z.infer<typeof HeadcountPayloadSchema>;

/** AI 一键生成 JD 的请求载荷（表单已填岗位要素 + 自由补充的背景描述） */
export interface JdGeneratePayload {
  title: string;
  deptName?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  location?: string | null;
  education?: string | null;
  experienceYears?: number | null;
  employmentType?: string | null;
  background?: string | null;
}

export const JdGenerateResultSchema = z.object({
  jobDescription: z.string().min(1),
  jobRequirement: z.string(),
  model: z.string().nullish(),
});
export type JdGenerateResult = z.infer<typeof JdGenerateResultSchema>;

// ---------- 展示标签 ----------

export const STATUS_LABELS: Record<HrRequestStatus, string> = {
  draft: '草稿',
  pending_approval: '审批中',
  open: '招聘中',
  closed: '已关闭',
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: '全职',
  part_time: '兼职',
  internship: '实习',
  contract: '合同制',
};

export const CLOSE_REASON_LABELS: Record<ClosePayload['closeReason'], string> = {
  filled: '招满关闭',
  cancelled: '取消招聘',
  frozen: '冻结',
};

/** 学历要求选项（后端存字典值，展示转文案） */
export const EDUCATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'high_school', label: '高中及以上' },
  { value: 'college', label: '大专及以上' },
  { value: 'bachelor', label: '本科及以上' },
  { value: 'master', label: '硕士及以上' },
  { value: 'phd', label: '博士及以上' },
];

export const EMPLOYMENT_TYPE_OPTIONS: ReadonlyArray<{ value: EmploymentType; label: string }> = [
  { value: 'full_time', label: '全职' },
  { value: 'part_time', label: '兼职' },
  { value: 'internship', label: '实习' },
  { value: 'contract', label: '合同制' },
];

export const CLOSE_REASON_OPTIONS: ReadonlyArray<{ value: ClosePayload['closeReason']; label: string }> = [
  { value: 'filled', label: '招满关闭' },
  { value: 'cancelled', label: '取消招聘' },
  { value: 'frozen', label: '冻结' },
];
