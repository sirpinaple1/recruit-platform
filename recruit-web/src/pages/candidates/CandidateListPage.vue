<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

import AppShell from '@/components/layout/AppShell.vue';
import CandidateDetailDialog from '@/pages/candidates/CandidateDetailDialog.vue';
import { fetchCandidatePage } from '@/lib/api/candidate.api';
import { ApiError } from '@/lib/httpClient';
import { cn, formatUtcIso } from '@/lib/utils';
import { SOURCE_CHANNEL_LABELS, type CandidateVO } from '@/types/candidate.types';

/**
 * 候选人库：简历采集链路的事实来源。
 *
 * 采集是「HR 在 BOSS 页面逐条主动点击」产生的（框架 §6 红线第 1 条），
 * 本页只读展示，不提供批量操作入口 —— 页面上一旦有批量按钮，
 * 采集行为就会从「逐条可审计」滑向「批量抓取」。
 */

const PAGE_SIZE = 10;

const rows = ref<CandidateVO[]>([]);
const total = ref(0);
const current = ref(1);
const loading = ref(false);
const errorMsg = ref('');

const keyword = ref('');
const sourceChannelFilter = ref('');

const detailId = ref<string | null>(null);

function sourceChipClass(source: string | null): string {
  return cn(
    'rounded px-2 py-0.5 text-[11.5px] font-medium',
    source === 'recommend' ? 'bg-[#EEF1FF] text-[#4F46E5]' : 'bg-[#EAF6EF] text-[#12A150]',
  );
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    const page = await fetchCandidatePage({
      page: current.value,
      size: PAGE_SIZE,
      keyword: keyword.value.trim() || undefined,
      sourceChannel: sourceChannelFilter.value || undefined,
    });
    rows.value = page.records;
    total.value = page.total;
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

/** 来源渠道切换：回到第 1 页并服务端重查 */
watch(sourceChannelFilter, () => {
  current.value = 1;
  void load();
});

/** 关键字：服务端按姓名模糊匹配，提交时回第 1 页 */
function search(): void {
  current.value = 1;
  void load();
}

const pages = ref(1);
watch(total, (t) => {
  pages.value = Math.max(1, Math.ceil(t / PAGE_SIZE));
});

function goPage(p: number): void {
  const target = Math.min(Math.max(1, p), pages.value);
  if (target === current.value) return;
  current.value = target;
  void load();
}

function openDetail(row: CandidateVO): void {
  detailId.value = row.id;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <AppShell title="候选人库">
    <!-- 工具栏 -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex h-[34px] w-[260px] items-center gap-2 rounded-md border border-line bg-white px-3 text-[12.5px]">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-t4">
          <g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">
            <circle cx="7.2" cy="7.2" r="4.4" />
            <path d="M10.6 10.6 13.6 13.6" />
          </g>
        </svg>
        <input
          v-model="keyword"
          class="h-full min-w-0 flex-1 bg-transparent text-t1 outline-none placeholder:text-t4"
          placeholder="按姓名搜索"
          @keyup.enter="search"
        />
      </div>
      <select
        v-model="sourceChannelFilter"
        class="h-[34px] cursor-pointer rounded-md border border-line bg-white pl-3 pr-8 text-[12.5px] text-t2 focus:border-primary focus:outline-none"
      >
        <option value="">全部来源</option>
        <option value="chat">候选人主动来</option>
        <option value="recommend">我方主动发</option>
      </select>
      <button
        class="h-[34px] rounded-md border border-line bg-white px-3 text-[12.5px] text-t2 transition hover:bg-hover"
        @click="search"
      >
        查询
      </button>
      <span class="text-[12px] text-t4">
        共 {{ total }} 位候选人 · 采集由浏览器扩展在 BOSS 页面逐条发起
      </span>
    </div>

    <!-- 表格卡片 -->
    <div class="overflow-hidden rounded-lg border border-line bg-white">
      <div class="grid grid-cols-[140px_140px_120px_130px_1.3fr_90px_90px_120px] items-center border-b border-divider bg-[#FAFBFC] px-5 py-2.5 text-[11.5px] font-medium text-t3">
        <div>候选人</div>
        <div>来源渠道</div>
        <div>期望职位</div>
        <div>期望薪资</div>
        <div>学历 / 院校</div>
        <div>简历版本</div>
        <div>附件</div>
        <div>最近采集</div>
      </div>

      <div v-if="loading" class="px-5 py-12 text-center text-sm text-t4">加载中…</div>
      <div v-else-if="errorMsg" class="px-5 py-12 text-center text-sm text-danger">{{ errorMsg }}</div>
      <div v-else-if="rows.length === 0" class="px-5 py-12 text-center text-sm text-t4">
        暂无候选人。请在 BOSS 直聘打开候选人简历或聊天窗口，点击页面右下角「采集到人才库」。
      </div>

      <div
        v-for="row in rows"
        :key="row.id"
        class="grid min-h-16 cursor-pointer grid-cols-[140px_140px_120px_130px_1.3fr_90px_90px_120px] items-center gap-3 border-b border-divider px-5 text-[13px] text-t2 transition last:border-b-0 hover:bg-[#FAFBFC]"
        @click="openDetail(row)"
      >
        <div class="min-w-0">
          <div class="truncate text-[13px] font-semibold text-t1">{{ row.name ?? '未知' }}</div>
          <div class="mt-0.5 truncate text-[11.5px] text-t4">
            <template v-if="row.age">{{ row.age }}</template>
            <template v-if="row.city"> · {{ row.city }}</template>
            <template v-if="row.workYear"> · {{ row.workYear }}</template>
          </div>
        </div>
        <div>
          <span :class="sourceChipClass(row.sourceChannel)">
            {{ SOURCE_CHANNEL_LABELS[row.sourceChannel ?? ''] ?? '—' }}
          </span>
        </div>
        <div class="min-w-0 truncate text-[12.5px] text-t3">{{ row.currentTitle ?? '—' }}</div>
        <div class="min-w-0 truncate text-[12.5px] text-t3">{{ row.expectSalary ?? '—' }}</div>
        <div class="min-w-0 truncate text-[12.5px] text-t3">
          {{ row.education ?? '—' }}<template v-if="row.school"> · {{ row.school }}</template>
        </div>
        <div class="text-[12.5px] text-t3">{{ row.versionCount ?? 0 }} 份</div>
        <div class="text-[12.5px] text-t3">{{ row.attachmentCount ?? 0 }} 个</div>
        <div class="text-[12.5px] text-t3">
          <template v-if="row.lastCollectedAt">{{ formatUtcIso(row.lastCollectedAt) }}</template>
          <template v-else>—</template>
        </div>
      </div>

      <!-- 分页底栏 -->
      <div class="flex h-[52px] items-center justify-between border-t border-divider px-5">
        <span class="text-xs text-t3">共 {{ total }} 条记录</span>
        <div class="flex items-center gap-2">
          <button
            class="h-[28px] rounded-md border border-line px-2.5 text-[12.5px] text-t2 transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="current <= 1"
            @click="goPage(current - 1)"
          >
            上一页
          </button>
          <span class="min-w-[64px] text-center text-[12.5px] text-t3">{{ current }} / {{ pages }}</span>
          <button
            class="h-[28px] rounded-md border border-line px-2.5 text-[12.5px] text-t2 transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="current >= pages"
            @click="goPage(current + 1)"
          >
            下一页
          </button>
        </div>
      </div>
    </div>

    <CandidateDetailDialog v-if="detailId" :candidate-id="detailId" @close="detailId = null" />
  </AppShell>
</template>
