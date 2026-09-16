import { z } from 'zod';

import { request } from '../httpClient';
import {
  ExtensionTokenCreatedVO,
  ExtensionTokenCreatedVOSchema,
  ExtensionTokenVO,
  ExtensionTokenVOSchema,
} from '@/types/extension-token.types';

/**
 * 扩展授权 API（契约见 ExtensionTokenController）。
 * 明文 token 仅 create 响应返回一次（红线 §5.5：不落库不落日志）。
 */

export function fetchExtensionTokenList(): Promise<ExtensionTokenVO[]> {
  return request({ method: 'GET', url: '/extension-tokens' }, z.array(ExtensionTokenVOSchema));
}

export function createExtensionToken(name: string): Promise<ExtensionTokenCreatedVO> {
  return request(
    { method: 'POST', url: '/extension-tokens', data: { name } },
    ExtensionTokenCreatedVOSchema,
  );
}

export function revokeExtensionToken(id: string): Promise<ExtensionTokenVO> {
  return request({ method: 'POST', url: `/extension-tokens/${id}/revoke` }, ExtensionTokenVOSchema);
}
