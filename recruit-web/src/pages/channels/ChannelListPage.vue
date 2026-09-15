<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { fetchChannelList } from '@/lib/api/channel.api';
import { ApiError } from '@/lib/httpClient';
import { formatUtcIso } from '@/lib/utils';
import AppShell from '@/components/layout/AppShell.vue';
import {
  CAPABILITY_LABELS,
  CHANNEL_STATUS_LABELS,
  type ChannelStatus,
  type ChannelVO,
} from '@/types/channel.types';
import ChannelFormDialog from './ChannelFormDialog.vue';

/**
 * 渠道管理页（对齐原型 s2-jobs 列表设计语言）。
 * 渠道量级小（个位数），后端一次性返回全量，搜索/筛选为客户端过滤。
 */

const CAPABILITY_CHIP_CLASS: Record<string, string> = {
  manual: 'bg-primary-tint text-primary',
  api: 'bg-[#F3EEFF] text-[#7C4DFF]',
  connector: 'bg-[#FEF6E7] text-[#D97706]',
  rpa: 'bg-[#F3F4F6] text-t2',
};

const STATUS_CHIP_CLASS: Record<ChannelStatus, string> = {
  enabled: 'bg-[#EAF6EF] text-[#12A150]',
  disabled: 'bg-[#F3F4F6] text-t2',
};

const channels = ref<ChannelVO[]>([]);
const loading = ref(false);
const errorMsg = ref('');
const keyword = ref('');
const capabilityFilter = ref('');
const statusFilter = ref('');

const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const formInitial = ref<ChannelVO | null>(null);

/** 搜索（名称/代码）+ 能力 / 状态筛选后的展示行，按 sortOrder 稳定排序 */
const visibleRows = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return channels.value
    .filter((c) => {
      if (capabilityFilter.value !== '' && c.capability !== capabilityFilter.value) return false;
      if (statusFilter.value !== '' && c.status !== statusFilter.value) return false;
      if (kw !== '' && !`${c.name} ${c.code}`.toLowerCase().includes(kw)) return false;
      return true;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
});

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    channels.value = await fetchChannelList();
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

function fieldCount(c: ChannelVO): number {
  if (!c.fieldMapJson || typeof c.fieldMapJson !== 'object') return 0;
  const fields = (c.fieldMapJson as Record<string, unknown>).fields;
  return Array.isArray(fields) ? fields.length : 0;
}

function openCreate(): void {
  formMode.value = 'create';
  formInitial.value = null;
  formVisible.value = true;
}

function openEdit(vo: ChannelVO): void {
  formMode.value = 'edit';
  formInitial.value = vo;
  formVisible.value = true;
}

function onFormSaved(): void {
  formVisible.value = false;
  void load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <AppShell title="渠道管理">
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
          placeholder="搜索渠道名称 / 代码"
        />
      </div>
      <select v-model="capabilityFilter" class="h-[34px] cursor-pointer rounded-md border border-line bg-white pl-3 pr-8 text-[12.5px] text-t2 focus:border-primary focus:outline-none">
        <option value="">全部能力</option>
        <option value="manual">手工发布</option>
        <option value="api">API 对接</option>
        <option value="connector">连接器</option>
        <option value="rpa">RPA</option>
      </select>
      <select v-model="statusFilter" class="h-[34px] cursor-pointer rounded-md border border-line bg-white pl-3 pr-8 text-[12.5px] text-t2 focus:border-primary focus:outline-none">
        <option value="">全部状态</option>
        <option value="enabled">启用</option>
        <option value="disabled">停用</option>
      </select>
      <button
        class="ml-auto flex h-[34px] items-center gap-1.5 rounded-md bg-primary px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110"
        @click="openCreate"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <g stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round">
            <path d="M8 3.4v9.2M3.4 8h9.2" />
          </g>
        </svg>
        新建渠道
      </button>
    </div>

    <!-- 表格卡片 -->
    <div class="overflow-hidden rounded-lg border border-line bg-white">
      <div class="grid grid-cols-[1.2fr_100px_110px_1.4fr_86px_120px_56px] items-center border-b border-divider bg-[#FAFBFC] px-5 py-2.5 text-[11.5px] font-medium text-t3">
        <div>渠道</div>
        <div>发布能力</div>
        <div>字段映射</div>
        <div>投递深链</div>
        <div>状态</div>
        <div>更新时间</div>
        <div>操作</div>
      </div>

      <div v-if="loading" class="px-5 py-12 text-center text-sm text-t4">加载中…</div>
      <div v-else-if="errorMsg" class="px-5 py-12 text-center text-sm text-danger">{{ errorMsg }}</div>
      <div v-else-if="visibleRows.length === 0" class="px-5 py-12 text-center text-sm text-t4">
        {{ channels.length === 0 ? '暂无渠道，点击右上角「新建渠道」创建' : '当前筛选条件下无匹配渠道' }}
      </div>

      <div
        v-for="row in visibleRows"
        :key="row.id"
        class="grid min-h-16 grid-cols-[1.2fr_100px_110px_1.4fr_86px_120px_56px] items-center gap-5 border-b border-divider px-5 text-[13px] text-t2 transition last:border-b-0 hover:bg-[#FAFBFC]"
      >
        <div class="min-w-0">
          <div class="truncate text-[13px] font-semibold text-t1">{{ row.name }}</div>
          <div class="mt-0.5 truncate text-[11.5px] text-t4">
            {{ row.code }}<template v-if="row.remark"> · {{ row.remark }}</template>
          </div>
        </div>
        <div>
          <span class="rounded px-2 py-0.5 text-[11.5px] font-medium" :class="CAPABILITY_CHIP_CLASS[row.capability]">
            {{ CAPABILITY_LABELS[row.capability] }}
          </span>
        </div>
        <div class="text-[12.5px] text-t3">
          <template v-if="fieldCount(row) > 0">{{ fieldCount(row) }} 个字段</template>
          <template v-else>—</template>
        </div>
        <div class="min-w-0 truncate font-mono text-[11.5px] text-t3">{{ row.deepLinkTemplate ?? '—' }}</div>
        <div>
          <span class="rounded px-2 py-0.5 text-[11.5px] font-medium" :class="STATUS_CHIP_CLASS[row.status]">
            {{ CHANNEL_STATUS_LABELS[row.status] }}
          </span>
        </div>
        <div class="text-[12.5px] text-t3">{{ formatUtcIso(row.updatedAt) }}</div>
        <div>
          <button class="text-[12.5px] font-medium text-primary transition hover:opacity-70" @click="openEdit(row)">
            编辑
          </button>
        </div>
      </div>

      <!-- 底部统计 -->
      <div class="flex h-[52px] items-center justify-between border-t border-divider px-5">
        <span class="text-xs text-t3">共 {{ visibleRows.length }} 个渠道</span>
        <span class="text-[11.5px] text-t4">审批通过的需求单将为每个「启用」渠道渲染发布草稿</span>
      </div>
    </div>

    <!-- 新建 / 编辑抽屉 -->
    <ChannelFormDialog
      :visible="formVisible"
      :mode="formMode"
      :initial="formInitial"
      @close="formVisible = false"
      @saved="onFormSaved"
    />
  </AppShell>
</template>
