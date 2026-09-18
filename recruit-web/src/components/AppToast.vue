<script setup lang="ts">
import { useToast, type ToastKind } from '@/composables/useToast';
import { cn } from '@/lib/utils';

/**
 * 全局 toast 渲染（挂载于 AppShell，页面通过 useToast() 触发）。
 */

const { toasts, dismiss } = useToast();

const ICON_PATHS: Record<ToastKind, string> = {
  success: 'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4Zm-0.9 8.2L5.3 7.9l.9-.9 1 1 2.6-2.6.9.9-3.6 3.3Z',
  error: 'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4Zm-.75 3h1.5v4h-1.5Zm0 5h1.5v1.5h-1.5Z',
};
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed right-5 top-5 z-[999] flex flex-col items-end gap-2">
      <TransitionGroup
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-1 opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-for="t in toasts"
          :key="t.id"
          role="status"
          class="pointer-events-auto flex w-[320px] max-w-full cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-white px-4 py-3 shadow-[0_8px_24px_rgba(31,41,55,0.12)]"
          @click="dismiss(t.id)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            class="mt-0.5 shrink-0"
            :class="t.kind === 'success' ? 'text-success' : 'text-danger'"
          >
            <path :d="ICON_PATHS[t.kind]" fill="currentColor" />
          </svg>
          <span
            class="text-[12.5px] leading-[1.5]"
            :class="cn(t.kind === 'success' ? 'text-t2' : 'text-danger')"
          >
            {{ t.message }}
          </span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
