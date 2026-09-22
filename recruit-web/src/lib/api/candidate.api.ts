import { z } from 'zod';

import { request, requestBlob } from '../httpClient';
import {
  CandidateDetailVO,
  CandidateDetailVOSchema,
  CandidatePage,
  CandidatePageSchema,
  ResumeScoreListSchema,
  ResumeScoreVO,
} from '@/types/candidate.types';

/**
 * 候选人库 API（契约见 CandidateController）。
 *
 * 读写分离：本文件只读；写入（采集）走扩展端 /api/ext/collect/**，
 * 由浏览器扩展用 X-Extension-Token 发起，中台前端不参与。
 */

export interface CandidatePageQuery {
  page: number;
  size: number;
  platform?: string;
  keyword?: string;
  sourceChannel?: string;
  /**
   * 需求单 ID（雪花，String 传输）。语义是「**投递过**该职位的候选人」——
   * 不是「最近一次投递是该职位」：一个人投了两个岗时，在两个岗位下都该出现。
   */
  requestId?: string;
}

export function fetchCandidatePage(query: CandidatePageQuery): Promise<CandidatePage> {
  return request(
    {
      method: 'GET',
      url: '/candidates',
      params: {
        page: query.page,
        size: query.size,
        ...(query.platform ? { platform: query.platform } : {}),
        ...(query.keyword ? { keyword: query.keyword } : {}),
        ...(query.sourceChannel ? { sourceChannel: query.sourceChannel } : {}),
        ...(query.requestId ? { requestId: query.requestId } : {}),
      },
    },
    CandidatePageSchema,
  );
}

export function fetchCandidateDetail(id: string): Promise<CandidateDetailVO> {
  return request(
    {
      method: 'GET',
      url: `/candidates/${id}`,
    },
    CandidateDetailVOSchema,
  );
}

/**
 * 候选人的 LLM 打分结果列表（最新在前）。
 *
 * 打分是采集落库后异步执行的：刚采集完的几秒内可能只有 pending 行、
 * 甚至还没有行 —— 调用方据此展示「打分中」或提供手动重打入口。
 */
export function fetchCandidateScores(candidateId: string): Promise<ResumeScoreVO[]> {
  return request(
    {
      method: 'GET',
      url: `/candidates/${candidateId}/scores`,
    },
    ResumeScoreListSchema,
  );
}

/** rescore 响应体（异步提交回执，不含结果本身） */
const RescoreResultSchema = z.object({
  resumeVersionId: z.string(),
  message: z.string(),
});
export type RescoreResult = z.infer<typeof RescoreResultSchema>;

/**
 * 手动重打：对候选人最新简历版本重新发起 LLM 打分（异步，接口立即返回）。
 * @param requestId 可选：指定与哪个需求单打匹配分；不传则自动取最新投递解析结果
 */
export function rescoreCandidate(candidateId: string, requestId?: string): Promise<RescoreResult> {
  return request(
    {
      method: 'POST',
      url: `/candidates/${candidateId}/rescore`,
      params: requestId ? { requestId } : {},
    },
    RescoreResultSchema,
  );
}

/**
 * 拉取附件正文（中台内联预览 / 下载）。
 *
 * 走登录态（Bearer），所以只能取回 Blob 再用 object URL 呈现，
 * 不能把后端地址直接交给浏览器 —— 详见 httpClient.requestBlob。
 * 调用方负责 `URL.revokeObjectURL`，否则每预览一份就漏一份内存（PDF 是 200KB 量级）。
 */
export function fetchAttachmentBlob(attachmentId: string): Promise<Blob> {
  return requestBlob({
    method: 'GET',
    url: `/candidates/attachments/${attachmentId}/content`,
  });
}
