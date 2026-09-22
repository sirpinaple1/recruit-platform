import { request } from '../httpClient';
import {
  PublishRecordPage,
  PublishRecordPageSchema,
  PublishRecordVO,
  PublishRecordVOSchema,
} from '@/types/publish-record.types';

/**
 * 发布台账 API（契约见 PublishRecordController）：分页 + channelId/status 筛选，
 * 以及人工绑定平台岗位（路径 B）。
 */

export interface PublishRecordPageQuery {
  page: number;
  size: number;
  channelId?: string;
  status?: string;
}

export function fetchPublishRecordPage(query: PublishRecordPageQuery): Promise<PublishRecordPage> {
  return request(
    {
      method: 'GET',
      url: '/publish-records',
      params: {
        page: query.page,
        size: query.size,
        ...(query.channelId ? { channelId: query.channelId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
    },
    PublishRecordPageSchema,
  );
}

/**
 * 人工绑定 / 更正 / 解除平台岗位映射（A 的兜底）。
 *
 * `platformJobId` 传 `null` 或空串表示**解除绑定** —— 后端把三列一起清空，
 * 该岗位下的投递随即回落为「未归类」（可见状态），而不是留着一个错的归属。
 *
 * 冲突（该岗位已被别的台账持有）后端返回 409，这里会抛 `ApiError`，由页面提示。
 */
export function bindPlatformJob(recordId: string, platformJobId: string | null): Promise<PublishRecordVO> {
  return request(
    {
      method: 'PUT',
      url: `/publish-records/${recordId}/platform-job`,
      data: { platformJobId: platformJobId?.trim() ? platformJobId.trim() : null },
    },
    PublishRecordVOSchema,
  );
}
