import { request } from '../httpClient';
import {
  ClosePayload,
  HeadcountPayload,
  HrRequestPage,
  HrRequestPageSchema,
  HrRequestSavePayload,
  HrRequestVO,
  HrRequestVOSchema,
  RejectPayload,
} from '@/types/hr-request.types';

/**
 * 人力需求单 API（契约见 HrRequestController）。
 * 业务失败（含非法状态转移）统一抛 ApiError(code, msg)。
 */

export function fetchHrRequestPage(params: {
  page: number;
  size: number;
  status?: string;
}): Promise<HrRequestPage> {
  return request({ method: 'GET', url: '/hr-requests', params }, HrRequestPageSchema);
}

export function fetchHrRequest(id: string): Promise<HrRequestVO> {
  return request({ method: 'GET', url: `/hr-requests/${id}` }, HrRequestVOSchema);
}

export function createHrRequest(payload: HrRequestSavePayload): Promise<HrRequestVO> {
  return request({ method: 'POST', url: '/hr-requests', data: payload }, HrRequestVOSchema);
}

export function updateHrRequest(id: string, payload: HrRequestSavePayload): Promise<HrRequestVO> {
  return request({ method: 'PUT', url: `/hr-requests/${id}`, data: payload }, HrRequestVOSchema);
}

export function submitHrRequest(id: string): Promise<HrRequestVO> {
  return request({ method: 'POST', url: `/hr-requests/${id}/submit` }, HrRequestVOSchema);
}

export function approveHrRequest(id: string): Promise<HrRequestVO> {
  return request({ method: 'POST', url: `/hr-requests/${id}/approve` }, HrRequestVOSchema);
}

export function rejectHrRequest(id: string, payload: RejectPayload): Promise<HrRequestVO> {
  return request({ method: 'POST', url: `/hr-requests/${id}/reject`, data: payload }, HrRequestVOSchema);
}

export function closeHrRequest(id: string, payload: ClosePayload): Promise<HrRequestVO> {
  return request({ method: 'POST', url: `/hr-requests/${id}/close`, data: payload }, HrRequestVOSchema);
}

export function reopenHrRequest(id: string): Promise<HrRequestVO> {
  return request({ method: 'POST', url: `/hr-requests/${id}/reopen` }, HrRequestVOSchema);
}

export function updateHeadcount(id: string, payload: HeadcountPayload): Promise<HrRequestVO> {
  return request({ method: 'POST', url: `/hr-requests/${id}/headcount`, data: payload }, HrRequestVOSchema);
}
