import { z } from 'zod';

import { request } from '../httpClient';
import {
  ChannelSavePayload,
  ChannelVO,
  ChannelVOSchema,
} from '@/types/channel.types';

/**
 * 渠道注册表 API（契约见 ChannelController）。
 * 渠道 code 创建后不可修改；fieldMapJson 传 JSON 字符串由后端规范化。
 */

export function fetchChannelList(): Promise<ChannelVO[]> {
  return request({ method: 'GET', url: '/channels' }, z.array(ChannelVOSchema));
}

export function createChannel(payload: ChannelSavePayload): Promise<ChannelVO> {
  return request({ method: 'POST', url: '/channels', data: payload }, ChannelVOSchema);
}

export function updateChannel(id: string, payload: ChannelSavePayload): Promise<ChannelVO> {
  return request({ method: 'PUT', url: `/channels/${id}`, data: payload }, ChannelVOSchema);
}
