<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { fetchMe } from '@/lib/api/auth.api';
import { fetchHrRequestPage } from '@/lib/api/hr-request.api';
import { ApiError } from '@/lib/httpClient';
import AppShell from '@/components/layout/AppShell.vue';
import { useAuthStore } from '@/stores/auth';
import { STATUS_LABELS, type HrRequestVO } from '@/types/hr-request.types';
import { STATUS_CHIP_CLASS } from './hr-requests/hr-request-ui';

/**
 * 工作台（对齐原型 s1-workbench）：状态统计卡 + 待我审批 + 招聘中职位进度。
 * 待办 / 面试日程依赖候选人模块（T5+），上线前以审批待办替代。
 */

const router = useRouter();
const authStore = useAuthStore();

const all = ref<HrRequestVO[]>([]);
const pendingApproval = ref<HrRequestVO[]>([]);
const openList = ref<HrRequestVO[]>([]);
const loading = ref(true);
const errorMsg = ref('');

const stats = computed(() => {
  const count = (s: string): number => all.value.filter((r) => r.status === s).length;
  return [
    { key: 'draft', label: '草稿职位', value: count('draft') },
    { key: 'pending_approval', label: '待我审批', value: count('pending_approval') },
    { key: 'open', label: '在招职位', value: count('open') },
    { key: 'closed', label: '已关闭', value: count('closed') },
  ];
});

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    await fetchMe().catch(() => undefined);
    const page = await fetchHrRequestPage({ page: 1, size: 100 });
    all.value = page.records;
    pendingApproval.value = page.records.filter((r) => r.status === 'pending_approval');
    openList.value = page.records.filter((r) => r.status === 'open').slice(0, 5);
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

function openDetail(vo: HrRequestVO): void {
  void router.push({ name: 'hr-request-detail', params: { id: vo.id } });
}

function goJobs(): void {
  void router.push({ name: 'hr-requests' });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <AppShell title="工作台">
    <!-- 统计卡 -->
    <div class="grid grid-cols-4 gap-4">
      <div
        v-for="s in stats"
        :key="s.key"
        class="cursor-pointer rounded-lg border border-line bg-white px-5 pb-4.5 pt-4 transition hover:border-primary-line"
        @click="goJobs"
      >
        <div class="text-xs text-t3">{{ s.label }}</div>
        <div class="mt-1.5 text-[28px] font-bold leading-tight tracking-tight" :class="s.key === 'pending_approval' && s.value > 0 ? 'text-warning' : ''">
          {{ s.value }}
        </div>
      </div>
    </div>

    <div v-if="loading" class="py-16 text-center text-sm text-t4">加载中…</div>
    <div v-else-if="errorMsg" class="py-16 text-center text-sm text-danger">{{ errorMsg }}</div>

    <div v-else class="grid grid-cols-[1fr_320px] items-start gap-5 max-[1279px]:grid-cols-[1fr_300px]">
      <!-- 左：待办 -->
      <div class="rounded-lg border border-line bg-white">
        <div class="flex items-center justify-between border-b-0 px-5 py-3.5">
          <span class="text-[13.5px] font-semibold">
            待我审批
            <span class="ml-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-page px-1.5 text-[11px] font-medium text-t3">
              {{ pendingApproval.length }}
            </span>
          </span>
          <button class="text-[12.5px] font-medium text-primary transition hover:opacity-70" @click="goJobs">查看全部</button>
        </div>

        <div v-if="pendingApproval.length === 0" class="border-t border-divider px-5 py-10 text-center text-sm text-t4">
          暂无待审批需求
        </div>
        <template v-else>
          <div class="bg-[#FAFBFC] px-5 py-2 text-[11.5px] font-medium text-t3">
            待审批 · {{ pendingApproval.length }} 项
          </div>
          <div
            v-for="row in pendingApproval"
            :key="row.id"
            class="flex cursor-pointer items-center justify-between gap-3.5 border-b border-divider px-5 py-3 last:border-b-0 hover:bg-[#FAFBFC]"
            @click="openDetail(row)"
          >
            <div>
              <div class="text-[13px] text-t1">{{ row.title }} · 待审批</div>
              <div class="mt-0.5 text-[11.5px] text-t4">
                {{ row.deptName }} · 招 {{ row.headcountTotal }} 人 · {{ row.requestNo }}
              </div>
            </div>
            <span class="shrink-0 text-[12.5px] font-medium text-primary">去处理</span>
          </div>
        </template>
      </div>

      <!-- 右栏 -->
      <div class="flex flex-col gap-5">
        <div class="rounded-lg border border-line bg-white">
          <div class="px-5 py-3.5 text-[13.5px] font-semibold">快速开始</div>
          <div class="px-5 pb-5 pt-0.5">
            <button
              class="h-[38px] w-full rounded-md bg-primary text-[13px] font-medium text-white transition hover:brightness-110"
              @click="goJobs"
            >
              新建职位
            </button>
            <div class="mt-4 flex flex-col gap-3">
              <span class="cursor-default text-[12.5px] text-t3">上传候选人简历，AI 自动解析（建设中）</span>
              <span class="cursor-default text-[12.5px] text-t3">邀请面试官加入协作（建设中）</span>
            </div>
          </div>
        </div>

        <div class="rounded-lg border border-line bg-white">
          <div class="flex items-center justify-between border-b border-divider px-5 py-3.5">
            <span class="text-[13.5px] font-semibold">招聘中职位</span>
            <button class="text-[12.5px] font-medium text-primary transition hover:opacity-70" @click="goJobs">查看全部</button>
          </div>
          <div class="flex flex-col gap-4 px-5 py-4">
            <div v-if="openList.length === 0" class="py-6 text-center text-[12.5px] text-t4">暂无在招职位</div>
            <div
              v-for="row in openList"
              :key="row.id"
              class="cursor-pointer"
              @click="openDetail(row)"
            >
              <div class="mb-1 flex items-center justify-between">
                <span class="text-[12.5px] text-t2">{{ row.title }}</span>
                <span class="text-[13px] font-semibold text-t1">
                  {{ row.headcountFilled }}<span class="font-normal text-t4">/{{ row.headcountTotal }}</span>
                </span>
              </div>
              <div class="h-1.5 overflow-hidden rounded bg-divider">
                <div
                  class="h-full rounded"
                  :class="row.headcountFilled >= row.headcountTotal ? 'bg-success' : 'bg-primary'"
                  :style="{ width: `${Math.min(100, Math.round((row.headcountFilled / row.headcountTotal) * 100))}%` }"
                ></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>
