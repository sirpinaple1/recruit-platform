import { z } from 'zod';

import { request } from '../httpClient';
import {
  PublishDraftVO,
  PublishDraftVOSchema,
} from '@/types/publish-draft.types';

/**
 * 发布草稿 API（管理端查询；扩展端拉草稿接口属 T3.3 独立鉴权，不在本文件）。
 */

export function fetchDraftsByRequest(requestId: string): Promise<PublishDraftVO[]> {
  return request(
    { method: 'GET', url: `/hr-requests/${requestId}/drafts` },
    z.array(PublishDraftVOSchema),
  );
}
