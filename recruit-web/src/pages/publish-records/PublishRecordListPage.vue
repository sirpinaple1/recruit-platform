<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import AppShell from '@/components/layout/AppShell.vue';
import PublishRecordJobBindDialog from '@/pages/publish-records/PublishRecordJobBindDialog.vue';
import { fetchChannelList } from '@/lib/api/channel.api';
import { fetchPublishRecordPage } from '@/lib/api/publish-record.api';
import { ApiError } from '@/lib/httpClient';
import { formatUtcIso } from '@/lib/utils';
import { type ChannelVO } from '@/types/channel.types';
import {
  PUBLISH_RECORD_STATUS_LABELS,
  type PublishRecordStatus,
  type PublishRecordVO,
} from '@/types/publish-record.types';

/**
 * 发布台账页：渠道/状态为服务端筛选（分页），关键字为当前页客户端过滤。
 * 台账是发布闭环的最终事实来源（pending → published / failed），
 * 也是**人工关联平台岗位**（路径 B，候选人与职位映射的兜底出口）的入口。
 */

const PAGE_SIZE = 10;

const STATUS_CHIP_CLASS: Record<PublishRecordStatus, string> = {
  pending: 'bg-[#F3F4F6] text-t2',
  published: 'bg-[#EAF6EF] text-[#12A150]',
  failed: 'bg-[#FDECEB] text-[#D83931]',
};

const records = ref<PublishRecordVO[]>([]);
const total = ref(0);
const current = ref(1);
const loading = ref(false);
const errorMsg = ref('');

const keyword = ref('');
const channelFilter = ref('');
const statusFilter = ref('');
const channels = ref<ChannelVO[]>([]);

/** 正在关联岗位的台账（非空时打开绑定抽屉） */
const bindTarget = ref<PublishRecordVO | null>(null);

const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 关键字（单号/职位名称）在当前页客户端过滤 */
const visibleRows = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (kw === '') return records.value;
  return records.value.filter((r) =>
    `${r.requestNo ?? ''} ${r.requestTitle ?? ''}`.toLowerCase().includes(kw),
  );
});

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    const page = await fetchPublishRecordPage({
      page: current.value,
      size: PAGE_SIZE,
      channelId: channelFilter.value || undefined,
      status: statusFilter.value || undefined,
    });
    records.value = page.records;
    total.value = page.total;
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

/** 渠道 / 状态筛选变化：回到第 1 页并服务端重查 */
watch([channelFilter, statusFilter], () => {
  current.value = 1;
  void load();
});

function goPage(p: number): void {
  const target = Math.min(Math.max(1, p), pages.value);
  if (target === current.value) return;
  current.value = target;
  void load();
}

onMounted(() => {
  void load();
  // 渠道下拉加载失败不阻塞台账本身
  void fetchChannelList()
    .then((list) => {
      channels.value = list;
    })
    .catch(() => {
      channels.value = [];
    });
});
</script>

<template>
  <AppShell title="发布台账">
    <!-- 工具栏 -->
    <div class="flex items-center gap-3">
      <div class="flex h-[34px] w-[240px] items-center gap-2 rounded-md border border-line bg-white px-3 text-[12.5px]">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-t4">
          <g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">
            <circle cx="7.2" cy="7.2" r="4.4" />
            <path d="M10.6 10.6 13.6 13.6" />
          </g>
        </svg>
        <input
          v-model="keyword"
          class="h-full min-w-0 flex-1 bg-transparent text-t1 outline-none placeholder:text-t4"
          placeholder="搜索单号 / 职位名称（当前页）"
        />
      </div>
      <select v-model="channelFilter" class="h-[34px] cursor-pointer rounded-md border border-line bg-white pl-3 pr-8 text-[12.5px] text-t2 focus:border-primary focus:outline-none">
        <option value="">全部渠道</option>
        <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <select v-model="statusFilter" class="h-[34px] cursor-pointer rounded-md border border-line bg-white pl-3 pr-8 text-[12.5px] text-t2 focus:border-primary focus:outline-none">
        <option value="">全部状态</option>
        <option value="pending">待发布</option>
        <option value="published">已发布</option>
        <option value="failed">失败</option>
      </select>
    </div>

    <!-- 表格卡片 -->
    <div class="overflow-hidden rounded-lg border border-line bg-white">
      <div class="grid grid-cols-[1.4fr_100px_130px_90px_110px_1.1fr_1.1fr_110px] items-center border-b border-divider bg-[#FAFBFC] px-5 py-2.5 text-[11.5px] font-medium text-t3">
        <div>需求</div>
        <div>渠道</div>
        <div>平台岗位</div>
        <div>状态</div>
        <div>账号标识</div>
        <div>发布链接</div>
        <div>结果备注</div>
        <div>发布时间</div>
      </div>

      <div v-if="loading" class="px-5 py-12 text-center text-sm text-t4">加载中…</div>
      <div v-else-if="errorMsg" class="px-5 py-12 text-center text-sm text-danger">{{ errorMsg }}</div>
      <div v-else-if="visibleRows.length === 0" class="px-5 py-12 text-center text-sm text-t4">
        {{ records.length === 0 ? '暂无发布记录，审批通过的需求单将自动生成待发布台账' : '当前筛选条件下无匹配记录' }}
      </div>

      <div
        v-for="row in visibleRows"
        :key="row.id"
        class="grid min-h-16 grid-cols-[1.4fr_100px_130px_90px_110px_1.1fr_1.1fr_110px] items-center gap-5 border-b border-divider px-5 text-[13px] text-t2 transition last:border-b-0 hover:bg-[#FAFBFC]"
      >
        <div class="min-w-0">
          <div class="truncate text-[13px] font-semibold text-t1">{{ row.requestTitle ?? '—' }}</div>
          <div class="mt-0.5 truncate font-mono text-[11.5px] text-t4">{{ row.requestNo ?? '—' }}</div>
        </div>
        <div class="min-w-0 truncate text-[12.5px] text-t3">{{ row.channelName ?? '—' }}</div>
        <!-- 平台岗位：映射键。点击进入人工关联（路径 B）—— A 自动捕获失败时这是唯一出口，
             因此即使是未关联状态也要是**可点的**，不能只显示一个灰色「—」。 -->
        <div class="min-w-0">
          <button
            class="w-full min-w-0 rounded-md px-1.5 py-1 text-left transition hover:bg-hover"
            :title="row.platformJobId ? '点击更正或解除关联' : '点击填写平台岗位 ID'"
            @click="bindTarget = row"
          >
            <template v-if="row.platformJobId">
              <div class="truncate font-mono text-[12px] text-t2">{{ row.platformJobId }}</div>
              <div class="mt-0.5 text-[11px] text-t4">
                {{ row.platformJobBindSource === 'manual' ? '人工绑定' : '自动捕获' }}
              </div>
            </template>
            <template v-else>
              <span class="text-[12.5px] text-warning">未关联</span>
              <div class="mt-0.5 text-[11px] text-t4">点击填写</div>
            </template>
          </button>
        </div>
        <div>
          <span class="rounded px-2 py-0.5 text-[11.5px] font-medium" :class="STATUS_CHIP_CLASS[row.status]">
            {{ PUBLISH_RECORD_STATUS_LABELS[row.status] }}
          </span>
        </div>
        <div class="min-w-0 truncate text-[12.5px] text-t3">{{ row.accountLabel ?? '—' }}</div>
        <div class="min-w-0">
          <a
            v-if="row.publishedUrl"
            :href="row.publishedUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="truncate text-[12.5px] text-primary transition hover:opacity-70"
          >{{ row.publishedUrl }}</a>
          <span v-else class="text-[12.5px] text-t4">—</span>
        </div>
        <div class="min-w-0 truncate text-[12.5px] text-t3" :title="row.resultNote ?? ''">
          {{ row.resultNote ?? '—' }}
        </div>
        <div class="text-[12.5px] text-t3">
          <template v-if="row.publishedAt">{{ formatUtcIso(row.publishedAt) }}</template>
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

    <!-- 人工关联平台岗位（路径 B）。保存成功后重查本页，让「来源/值」立即反映真实状态 -->
    <PublishRecordJobBindDialog
      :visible="bindTarget !== null"
      :record="bindTarget"
      @close="bindTarget = null"
      @saved="load()"
    />
  </AppShell>
</template>
