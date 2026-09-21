import { z } from 'zod';

/**
 * 候选人库类型与 Zod schema（契约见 CandidateController / CandidateVO）。
 *
 * 三层实体（框架 §4.1）：候选人 → 简历版本（1..n）→ 附件（1..n），
 * 外加 append-only 的采集审计流水。
 */

// ---------- 候选人 ----------

export const CandidateVOSchema = z.object({
  id: z.string(),
  platform: z.string(),
  platformUserId: z.string(),
  /** 同一人的另一种 ID 形态（BOSS 数字 uid ↔ 加密 geekId）；null = 尚未学到 */
  platformUserIdAlt: z.string().nullable(),
  name: z.string().nullable(),
  currentTitle: z.string().nullable(),
  expectSalary: z.string().nullable(),
  city: z.string().nullable(),
  education: z.string().nullable(),
  school: z.string().nullable(),
  major: z.string().nullable(),
  workYear: z.string().nullable(),
  age: z.string().nullable(),
  gender: z.number().nullable(),
  /** 首次采集来源：chat 候选人主动来 / recommend 我方主动发 */
  sourceChannel: z.string().nullable(),
  versionCount: z.number().nullable(),
  attachmentCount: z.number().nullable(),
  mergedIntoId: z.string().nullable(),
  firstCollectedAt: z.string().nullable(),
  lastCollectedAt: z.string().nullable(),
});
export type CandidateVO = z.infer<typeof CandidateVOSchema>;

export const CandidatePageSchema = z.object({
  records: z.array(CandidateVOSchema),
  total: z.number(),
  size: z.number(),
  current: z.number(),
});
export type CandidatePage = z.infer<typeof CandidatePageSchema>;

// ---------- 简历版本 ----------

export const ResumeVersionVOSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  /** chat 聊天 / list 列表 / detail 详情页 */
  source: z.string(),
  sourceApi: z.string().nullable(),
  platformResumeId: z.string().nullable(),
  /** 归一字段 JSON 字符串（一期字段集未稳定，按字符串透出，前端自行解析） */
  fieldsJson: z.string().nullable(),
  fieldCount: z.number().nullable(),
  /** 1 表示原始快照是密文原文，一期未解密（在线简历详情页） */
  rawEncrypted: z.number().nullable(),
  rawBytes: z.number().nullable(),
  rawTruncated: z.number().nullable(),
  contentHash: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  collectedAt: z.string().nullable(),
  operatedBy: z.string().nullable(),
  operatorName: z.string().nullable(),
});
export type ResumeVersionVO = z.infer<typeof ResumeVersionVOSchema>;

// ---------- 附件 ----------

export const AttachmentVOSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  resumeVersionId: z.string().nullable(),
  platformFileId: z.string(),
  fileName: z.string().nullable(),
  contentType: z.string().nullable(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  /** pending 待下载 / stored 已落盘 / failed 下载失败 */
  status: z.string(),
  failReason: z.string().nullable(),
  sourceScene: z.string().nullable(),
  originUrl: z.string().nullable(),
  originTicketExpiresAt: z.string().nullable(),
  storageKey: z.string().nullable(),
  /** 中台能否直接打开（服务端按「已落盘 + 文件确实在盘上」算出） */
  openable: z.boolean().nullable(),
  collectedAt: z.string().nullable(),
  storedAt: z.string().nullable(),
});
export type AttachmentVO = z.infer<typeof AttachmentVOSchema>;

// ---------- 采集审计 ----------

export const CollectAuditVOSchema = z.object({
  id: z.string(),
  action: z.string(),
  result: z.string(),
  operatorId: z.string().nullable(),
  operatorName: z.string().nullable(),
  platform: z.string(),
  platformUserId: z.string().nullable(),
  candidateId: z.string().nullable(),
  scene: z.string().nullable(),
  pageUrl: z.string().nullable(),
  sourceApi: z.string().nullable(),
  clientNote: z.string().nullable(),
  occurredAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type CollectAuditVO = z.infer<typeof CollectAuditVOSchema>;

// ---------- 详情 ----------

export const CandidateDetailVOSchema = z.object({
  candidate: CandidateVOSchema,
  versions: z.array(ResumeVersionVOSchema),
  attachments: z.array(AttachmentVOSchema),
  audits: z.array(CollectAuditVOSchema),
});
export type CandidateDetailVO = z.infer<typeof CandidateDetailVOSchema>;

/** fieldsJson 解析后的宽松结构：一期不固化字段集，只取需要的几个做展示 */
export const ResumeFieldsSchema = z.record(z.string(), z.unknown());
export type ResumeFields = z.infer<typeof ResumeFieldsSchema>;

// ---------- 展示标签 ----------

export const SOURCE_CHANNEL_LABELS: Record<string, string> = {
  chat: '候选人主动来',
  recommend: '我方主动发',
};

export const SCENE_LABELS: Record<string, string> = {
  chat: '聊天',
  list: '列表',
  detail: '简历详情',
  attach: '附件预览',
  /** 扩展用候选人加密 geekId 主动探测到的附件（HR 未点预览） */
  probe: '自动探测',
  /** 无 ID 佐证、按「同标签页最近预览」兜底认领的附件 */
  attach_tab: '同页认领',
};

export const ATTACHMENT_STATUS_LABELS: Record<string, string> = {
  pending: '待下载',
  stored: '已入库',
  failed: '失败',
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  consent: '采集前确认',
  collect: '提交采集',
  attach_download: '附件下载',
  merge: '归并',
  skip: '去重跳过',
};

export const GENDER_LABELS: Record<number, string> = {
  1: '男',
  2: '女',
};
