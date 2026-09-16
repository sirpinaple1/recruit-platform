import { request } from '../httpClient';
import {
  PublishRecordPage,
  PublishRecordPageSchema,
} from '@/types/publish-record.types';

/**
 * 发布台账 API（契约见 PublishRecordController）：分页 + channelId/status 筛选。
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
