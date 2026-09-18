import { ref } from 'vue';

/**
 * 轻量 toast（无第三方依赖）。
 * 模块级状态 + useToast() 全局共享；渲染由 AppToast.vue 负责（挂载在 AppShell）。
 */

export type ToastKind = 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const toasts = ref<ToastItem[]>([]);

let nextId = 0;
const DEFAULT_DURATION = 4500;
const MAX_STACK = 5;

function push(kind: ToastKind, message: string, duration = DEFAULT_DURATION): void {
  const item: ToastItem = { id: ++nextId, kind, message };
  toasts.value = [...toasts.value, item].slice(-MAX_STACK);
  window.setTimeout(() => dismiss(item.id), duration);
}

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function useToast() {
  return {
    toasts,
    dismiss,
    success: (message: string, duration?: number) => push('success', message, duration),
    error: (message: string, duration?: number) => push('error', message, duration),
  };
}
