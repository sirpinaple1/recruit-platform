import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { type ZodType } from 'zod';

import router from '@/router';
import { TOKEN_KEY, clearAuth } from '@/stores/auth';

/**
 * 统一 HTTP 客户端（规范：禁止直接 import axios / fetch，一律走本模块）。
 *
 * 后端响应约定（R<T>）有两种到达路径，需同时兼容：
 * 1. 业务错误（GlobalExceptionHandler / MyException）：HTTP 200 + body.code 为 401/403/400/500…
 * 2. 拦截器拒绝（AuthInterceptor / RoleInterceptor）：真 HTTP 401（未登录）或 403（无权限）+ body {code, msg}
 */

export class ApiError extends Error {
  readonly code: number;

  constructor(code: number, msg: string) {
    super(msg);
    this.name = 'ApiError';
    this.code = code;
  }
}

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE ?? '/api',
  timeout: 15_000,
});

// 请求拦截：自动附带 Bearer token
http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

interface RBody {
  code: number;
  msg: string;
  data?: unknown;
}

function toApiError(fallback: string, body?: RBody | null, status?: number): ApiError {
  if (body && typeof body.code === 'number' && typeof body.msg === 'string') {
    return new ApiError(body.code, body.msg);
  }
  return new ApiError(status ?? -1, fallback);
}

function handleUnauthorized(): void {
  // 仅在非登录页触发跳转，避免登录失败（HTTP 200 + code 401）之外的误跳
  if (router.currentRoute.value.name !== 'login') {
    clearAuth();
    void router.push({ name: 'login' });
  }
}

// 响应拦截：解包 R 结构
http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<RBody | Blob>) => {
    const status = error.response?.status;
    let body = error.response?.data;
    // responseType:'blob' 时错误体也是 Blob，要先读回文本才能拿到后端真正的 R 结构；
    // 不处理就会一律退化成「网络异常，请稍后重试」，把「附件尚未落盘」这类
    // 可操作的提示吞掉（附件预览正是这一路）。
    if (body instanceof Blob) {
      try {
        body = JSON.parse(await body.text()) as RBody;
      } catch {
        body = undefined;
      }
    }
    if (status === 401) {
      handleUnauthorized();
      throw toApiError('未登录或登录已过期', body, 401);
    }
    // 403 = 已登录但无权限（RoleInterceptor / MyException）：不清登录态，透出后端提示
    if (status === 403) {
      throw toApiError('无权访问该功能', body, 403);
    }
    throw toApiError('网络异常，请稍后重试', body, status);
  },
);

/**
 * 发起请求并解包：HTTP 2xx 且 body.code === 200 时，
 * 用传入的 Zod schema 校验 data 后返回；否则抛 ApiError。
 */
export async function request<T>(config: AxiosRequestConfig, schema: ZodType<T>): Promise<T> {
  const response = await http.request<RBody>(config);
  const body = response.data;

  if (body.code !== 200 || body.data === undefined || body.data === null) {
    throw new ApiError(body.code, body.msg || '请求失败');
  }

  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    console.error('API 响应数据校验失败', parsed.error.issues);
    throw new ApiError(500, '响应数据异常，请联系管理员');
  }
  return parsed.data;
}

/**
 * 拉取二进制响应（附件正文预览 / 下载）。
 *
 * 与 {@link request} 的区别只有两点：不做 Zod 解包（二进制没法解），以及
 * 需要自己识别「后端用 R 结构报的错」——
 *
 * 后端业务异常走 GlobalExceptionHandler，是 **HTTP 200 + body.code 非 200**，
 * 对 responseType:'blob' 来说就是一个 content-type 为 application/json 的 Blob。
 * 不额外判一次，前端就会把一个 JSON 错误体当成 PDF 塞给预览窗口。
 *
 * 为什么不把附件 URL 直接给 `<a href>` / `<iframe src>`：本端点走登录态，
 * 鉴权靠 `Authorization: Bearer` 请求头，裸链接带不上这个头 —— 所以必须由
 * 本模块（唯一允许碰 axios 的地方）取回字节，再由调用方转成 object URL 使用。
 */
export async function requestBlob(config: AxiosRequestConfig): Promise<Blob> {
  const response = await http.request<Blob>({ ...config, responseType: 'blob' });
  const blob = response.data;

  if (!blob || blob.size === 0) {
    throw new ApiError(500, '附件内容为空');
  }
  if ((blob.type || '').includes('json')) {
    let body: RBody | null = null;
    try {
      body = JSON.parse(await blob.text()) as RBody;
    } catch {
      body = null;
    }
    throw toApiError('附件读取失败', body, response.status);
  }
  return blob;
}
