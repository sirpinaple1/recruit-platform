import { request, requestBlob } from '../httpClient';
import {
  CandidateDetailVO,
  CandidateDetailVOSchema,
  CandidatePage,
  CandidatePageSchema,
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
