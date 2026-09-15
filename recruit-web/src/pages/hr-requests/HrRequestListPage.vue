<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { fetchHrRequestPage } from '@/lib/api/hr-request.api';
import { ApiError } from '@/lib/httpClient';
import { formatUtcIso } from '@/lib/utils';
import { STATUS_LABELS, type HrRequestVO } from '@/types/hr-request.types';
import HrRequestDetailDialog from './HrRequestDetailDialog.vue';
import HrRequestFormDialog from './HrRequestFormDialog.vue';
import { STATUS_CHIP_CLASS } from './hr-request-ui';

/** 需求单管理列表页（T2 前端） */

const STATUS_TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'pending_approval', label: '审批中' },
  { value: 'open', label: '招聘中' },
  { value: 'closed', label: '已关闭' },
];

const PAGE_SIZE = 10;

const statusFilter = ref('');
const current = ref(1);
const pages = ref(1);
const total = ref(0);
const records = ref<HrRequestVO[]>([]);
const loading = ref(false);
const errorMsg = ref('');

const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const formInitial = ref<HrRequestVO | null>(null);

const detailVisible = ref(false);
const detailRequest = ref<HrRequestVO | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    const page = await fetchHrRequestPage({
      page: current.value,
      size: PAGE_SIZE,
      status: statusFilter.value === '' ? undefined : statusFilter.value,
    });
    records.value = page.records;
    total.value = page.total;
    pages.value = page.pages;
    if (current.value > page.pages && page.pages > 0) {
      current.value = page.pages;
      await load();
    }
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

function switchTab(value: string): void {
  if (statusFilter.value === value) return;
  statusFilter.value = value;
  current.value = 1;
  void load();
}

function prevPage(): void {
  if (current.value > 1) {
    current.value -= 1;
    void load();
  }
}

function nextPage(): void {
  if (current.value < pages.value) {
    current.value += 1;
    void load();
  }
}

function openCreate(): void {
  formMode.value = 'create';
  formInitial.value = null;
  formVisible.value = true;
}

function openEdit(vo: HrRequestVO): void {
  formMode.value = 'edit';
  formInitial.value = vo;
  formVisible.value = true;
}

function openDetail(vo: HrRequestVO): void {
  detailRequest.value = vo;
  detailVisible.value = true;
}

function onFormSaved(): void {
  formVisible.value = false;
  void load();
}

function onDetailUpdated(vo: HrRequestVO): void {
  detailRequest.value = vo;
  void load();
}

function onDetailEdit(vo: HrRequestVO): void {
  detailVisible.value = false;
  openEdit(vo);
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="min-h-screen bg-page">
    <!-- 顶栏 -->
    <header class="flex h-14 items-center justify-between border-b border-line bg-white px-6">
      <div class="flex items-baseline gap-3">
        <h1 class="text-[15px] font-semibold">需求单管理</h1>
        <span class="text-[12.5px] text-t3">人力需求 · 审批 · 发布</span>
      </div>
      <router-link to="/" class="text-[12.5px] text-t3 transition hover:text-primary">← 返回工作台</router-link>
    </header>

    <div class="mx-auto flex max-w-[1180px] flex-col gap-4 p-6">
      <!-- 工具条 -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1">
          <button
            v-for="tab in STATUS_TABS"
            :key="tab.value"
            class="h-8 rounded-md px-3 text-[12.5px] transition"
            :class="
              statusFilter === tab.value
                ? 'bg-primary-tint font-medium text-primary'
                : 'text-t3 hover:bg-hover hover:text-t2'
            "
            @click="switchTab(tab.value)"
          >
            {{ tab.label }}
          </button>
        </div>
        <button
          class="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition hover:brightness-110"
          @click="openCreate"
        >
          + 新建需求单
        </button>
      </div>

      <!-- 表格卡片 -->
      <div class="overflow-hidden rounded-lg border border-line bg-white">
        <div class="grid grid-cols-[1fr_110px_100px_140px_72px] items-center border-b border-divider px-5 py-3 text-xs text-t4">
          <div>需求单</div>
          <div>招聘进度</div>
          <div>状态</div>
          <div>创建时间</div>
          <div class="text-right">操作</div>
        </div>

        <div v-if="loading" class="px-5 py-12 text-center text-sm text-t4">加载中…</div>
        <div v-else-if="errorMsg" class="px-5 py-12 text-center text-sm text-danger">{{ errorMsg }}</div>
        <div v-else-if="records.length === 0" class="px-5 py-12 text-center text-sm text-t4">
          暂无需求单，点击右上角「新建需求单」创建
        </div>

        <div
          v-for="row in records"
          :key="row.id"
          class="grid cursor-pointer grid-cols-[1fr_110px_100px_140px_72px] items-center border-b border-divider px-5 py-3.5 transition last:border-b-0 hover:bg-page"
          @click="openDetail(row)"
        >
          <div class="min-w-0">
            <div class="truncate text-[13px] font-medium text-t1">{{ row.title }}</div>
            <div class="mt-0.5 truncate text-[11px] text-t4">
              {{ row.requestNo }} · {{ row.deptName }}<template v-if="row.location"> · {{ row.location }}</template>
            </div>
          </div>
          <div class="text-[13px] text-t2">
            <span class="font-semibold text-t1">{{ row.headcountFilled }}</span>
            <span class="text-t4">/{{ row.headcountTotal }}</span>
          </div>
          <div>
            <span class="rounded-sm px-2 py-0.5 text-xs font-medium" :class="STATUS_CHIP_CLASS[row.status]">
              {{ STATUS_LABELS[row.status] }}
            </span>
          </div>
          <div class="text-[12.5px] text-t3">{{ formatUtcIso(row.createdAt) }}</div>
          <div class="text-right">
            <button
              v-if="row.status === 'draft'"
              class="text-[12.5px] text-primary hover:underline"
              @click.stop="openEdit(row)"
            >
              编辑
            </button>
            <button v-else class="text-[12.5px] text-primary hover:underline" @click.stop="openDetail(row)">
              查看
            </button>
          </div>
        </div>

        <!-- 分页 -->
        <div class="flex items-center justify-between border-t border-divider px-5 py-3">
          <span class="text-xs text-t4">共 {{ total }} 条</span>
          <div class="flex items-center gap-2">
            <button
              class="h-7 rounded-md border border-line px-2.5 text-xs text-t3 transition hover:border-t4 disabled:opacity-40"
              :disabled="current <= 1 || loading"
              @click="prevPage"
            >
              上一页
            </button>
            <span class="text-xs text-t3">{{ current }} / {{ pages }}</span>
            <button
              class="h-7 rounded-md border border-line px-2.5 text-xs text-t3 transition hover:border-t4 disabled:opacity-40"
              :disabled="current >= pages || loading"
              @click="nextPage"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹窗 -->
    <HrRequestFormDialog
      :visible="formVisible"
      :mode="formMode"
      :initial="formInitial"
      @close="formVisible = false"
      @saved="onFormSaved"
    />
    <HrRequestDetailDialog
      :visible="detailVisible"
      :request="detailRequest"
      @close="detailVisible = false"
      @updated="onDetailUpdated"
      @edit="onDetailEdit"
    />
  </div>
</template>
