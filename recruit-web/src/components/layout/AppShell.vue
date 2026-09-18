<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import AppToast from '@/components/AppToast.vue';

/**
 * 应用外壳：侧栏 + 顶栏（对齐原型 workbench/s1-s9 共享布局）。
 * 未上线模块（候选人/面试/数据/简历门户）以禁用态占位，路由可达后启用。
 */

defineProps<{
  /** 顶栏标题（当前页名） */
  title: string;
  /** 可选面包屑前缀（如详情页「职位 / 后端工程师」中的「职位」） */
  crumb?: string;
}>();

const route = useRoute();
const router = useRouter();
const { user, logout } = useAuthStore();

onMounted(() => {
  if (sessionStorage.getItem('justLoggedIn') === 'true') {
    sessionStorage.removeItem('justLoggedIn');
    window.location.reload();
  }
});

const ROLE_LABELS: Record<string, string> = {
  ADMIN: '系统管理员',
  HR: '招聘负责人',
};

interface NavItem {
  name: string;
  label: string;
  icon: string;
  disabled?: boolean;
  /** 仅管理员可见（对应路由 meta.role，见 ADR-001） */
  adminOnly?: boolean;
}

/** 导航项：icon 为 16x16 viewBox 内的 SVG path 组（stroke 风格，对齐原型） */
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { name: 'workbench', label: '工作台', icon: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z' },
  { name: 'hr-requests', label: '职位', icon: 'M2 5h12v9H2zM6 5V3.6A1.6 1.6 0 0 1 7.6 2h.8A1.6 1.6 0 0 1 10 3.6V5M2 8.6h12' },
  { name: 'candidates', label: '候选人', icon: 'M8.8 8.2a2.4 2.4 0 1 0-4.8 0 2.4 2.4 0 0 0 4.8 0zM2.2 13.4c0-2.2 1.9-3.6 4.2-3.6s4.2 1.4 4.2 3.6M10.6 4.1a2.4 2.4 0 0 1 0 4.4M12 10c1.2.5 1.8 1.7 1.8 3.4', disabled: true },
  { name: 'interviews', label: '面试', icon: 'M2 3.5h12V14H2zM2 6.8h12M5.5 2v3M10.5 2v3', disabled: true },
  { name: 'analytics', label: '数据', icon: 'M2 13.5h12M4.2 11.4V8.6M8 11.4V5.4M11.8 11.4V9.6', disabled: true },
  { name: 'channels', label: '渠道管理', icon: 'M2 3h12v10H2zM2 6.5h12M5 6.5v6.5', adminOnly: true },
  { name: 'publish-records', label: '发布台账', icon: 'M3 2h10v12H3zM5.5 5.5h5M5.5 8.5h5M5.5 11.5h3' },
  { name: 'extension-tokens', label: '扩展授权', icon: 'M4 7h8v6H4zM6 7V5a2 2 0 0 1 4 0v2', adminOnly: true },
];

/** 按当前用户角色过滤导航（后端才是授权权威，此处仅隐藏入口） */
const visibleNavItems = computed(() =>
  NAV_ITEMS.filter((item) => !item.adminOnly || user.value?.role === 'ADMIN'),
);

const todayText = computed(() => {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
});

const userInitial = computed(() => (user.value?.realName ?? '访').slice(0, 1));
const userRoleLabel = computed(() =>
  user.value ? (ROLE_LABELS[user.value.role] ?? user.value.role) : '',
);

function onNavClick(item: NavItem): void {
  if (item.disabled || route.name === item.name) return;
  void router.push({ name: item.name });
}

function onUserClick(): void {
  logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <div class="flex h-screen overflow-hidden">
    <!-- 侧栏 -->
    <aside class="flex w-[240px] shrink-0 flex-col border-r border-line bg-[#FCFCFD] px-3 pb-3.5 pt-4">
      <div class="flex items-center gap-2.5 px-2 pb-5">
        <div class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary">
          <svg width="17" height="17" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 3 L22 13 H18.5 L24 22 H6 L11.5 13 H8 L15 3 Z" fill="#FFFFFF" />
            <rect x="13" y="22" width="4" height="5" rx="1" fill="#FFFFFF" opacity="0.65" />
          </svg>
        </div>
        <span class="text-[15px] font-semibold tracking-[0.2px]">招聘中台</span>
      </div>

      <nav class="flex flex-1 flex-col gap-0.5">
        <button
          v-for="item in visibleNavItems"
          :key="item.name"
          type="button"
          class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition"
          :class="[
            route.name === item.name
              ? 'bg-primary-tint font-medium text-primary'
              : item.disabled
                ? 'cursor-not-allowed text-t4 opacity-60'
                : 'text-t2 hover:bg-hover',
          ]"
          :title="item.disabled ? '建设中' : item.label"
          @click="onNavClick(item)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" class="shrink-0">
            <g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path :d="item.icon" />
            </g>
          </svg>
          <span>{{ item.label }}</span>
          <span v-if="item.disabled" class="ml-auto text-[10px] text-t4">建设中</span>
        </button>
      </nav>

      <button
        type="button"
        class="flex items-center gap-2.5 rounded-lg p-2 text-left transition hover:bg-hover"
        title="点击退出登录"
        @click="onUserClick"
      >
        <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#D9DDE5] to-[#EEF0F4] text-[11px] text-t3">
          {{ userInitial }}
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[12.5px] font-medium leading-tight">
            {{ user?.realName ?? '未登录' }}
          </span>
          <span class="block truncate text-[11px] leading-tight text-t4">{{ userRoleLabel }}</span>
        </span>
      </button>
    </aside>

    <!-- 主区 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-[62px] shrink-0 items-center justify-between gap-4 border-b border-line bg-white px-6">
        <div class="flex min-w-0 items-baseline gap-2.5">
          <template v-if="crumb">
            <span class="whitespace-nowrap text-[15px] text-t3">{{ crumb }}</span>
            <span class="text-[15px] text-t4">/</span>
          </template>
          <span class="truncate text-[15px] font-semibold">{{ title }}</span>
          <span class="ml-1 whitespace-nowrap text-xs text-t4">{{ todayText }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <div class="flex h-[34px] w-[236px] items-center gap-2 rounded-lg bg-page px-2.5 text-[12.5px] text-t4">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">
                <circle cx="7.2" cy="7.2" r="4.4" />
                <path d="M10.6 10.6 13.6 13.6" />
              </g>
            </svg>
            <span>搜索职位、候选人</span>
            <span class="ml-auto rounded border border-line bg-white px-1 text-[10px] leading-[15px] text-t4">HK</span>
          </div>
          <button
            type="button"
            class="flex h-[34px] items-center gap-1.5 rounded-lg border border-[#E1D5FF] bg-[#F3EEFF] px-3 text-[12.5px] font-medium text-[#6A3FE0] transition hover:bg-[#EDE4FF]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7 1.4 8.35 5.65 12.6 7 8.35 8.35 7 12.6 5.65 8.35 1.4 7 5.65 5.65Z" fill="#7C4DFF" />
              <circle cx="11.6" cy="2.4" r="1.3" fill="#7C4DFF" opacity=".55" />
            </svg>
            AI 助手
          </button>
          <button type="button" class="relative flex size-[34px] items-center justify-center rounded-lg border border-line bg-white text-t3 transition hover:border-[#D6DAE0] hover:text-t2" aria-label="通知">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round">
                <path d="M8 2.2a3.9 3.9 0 0 1 3.9 3.9v2.3l1 2.1H3.1l1-2.1V6.1A3.9 3.9 0 0 1 8 2.2Z" />
                <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" />
              </g>
            </svg>
            <span class="absolute right-2 top-[7px] size-1.5 rounded-full border-[1.5px] border-white bg-danger"></span>
          </button>
          <span class="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-[#D9DDE5] to-[#EEF0F4] text-[11px] text-t3">
            {{ userInitial }}
          </span>
        </div>
      </header>

      <div class="relative flex-1 overflow-auto bg-page p-6">
        <div class="flex flex-col gap-5">
          <slot />
        </div>
      </div>
    </div>

    <!-- 全局 toast（useToast() 触发） -->
    <AppToast />
  </div>
</template>
