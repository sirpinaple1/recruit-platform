<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { fetchHrRequestPage } from '@/lib/api/hr-request.api';
import { ApiError } from '@/lib/httpClient';
import { formatUtcIso } from '@/lib/utils';
import AppShell from '@/components/layout/AppShell.vue';
import { STATUS_LABELS, type HrRequestVO } from '@/types/hr-request.types';
import HrRequestFormDialog from './HrRequestFormDialog.vue';
import { STATUS_CHIP_CLASS } from './hr-request-ui';

/**
 * 职位列表页（对齐原型 s2-jobs：搜索 + 状态筛选 + 表格 + 分页）。
 * 搜索与部门筛选为当前页客户端过滤（后端暂未提供对应查询参数）。
 */

const PAGE_SIZE = 10;

const router = useRouter();

const statusFilter = ref('');
const keyword = ref('');
const current = ref(1);
const pages = ref(1);
const total = ref(0);
const records = ref<HrRequestVO[]>([]);
const loading = ref(false);
const errorMsg = ref('');

const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const formInitial = ref<HrRequestVO | null>(null);

/** 当前页部门选项（distinct，用于部门下拉） */
const deptOptions = computed(() => {
  const set = new Set(records.value.map((row) => row.deptName));
  return ['', ...Array.from(set).sort()];
});
const deptFilter = ref('');

/** 客户端过滤后的展示行 */
const visibleRows = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return records.value.filter((row) => {
    if (deptFilter.value !== '' && row.deptName !== deptFilter.value) return false;
    if (kw !== '' && !`${row.title} ${row.requestNo}`.toLowerCase().includes(kw)) return false;
    return true;
  });
});

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

function switchStatus(value: string): void {
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
  void router.push({ name: 'hr-request-detail', params: { id: vo.id } });
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
  <AppShell title="职位">
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
          placeholder="搜索职位名称 / 编号"
        />
      </div>
      <select
        class="h-[34px] cursor-pointer rounded-md border border-line bg-white pl-3 pr-8 text-[12.5px] text-t2 focus:border-primary focus:outline-none"
        :value="statusFilter"
        @change="switchStatus(String(($event.target as HTMLSelectElement).value))"
      >
        <option value="">全部状态</option>
        <option value="draft">草稿</option>
        <option value="pending_approval">审批中</option>
        <option value="open">招聘中</option>
        <option value="closed">已关闭</option>
      </select>
      <select
        v-model="deptFilter"
        class="h-[34px] cursor-pointer rounded-md border border-line bg-white pl-3 pr-8 text-[12.5px] text-t2 focus:border-primary focus:outline-none"
      >
        <option value="">全部部门</option>
        <option v-for="d in deptOptions.slice(1)" :key="d" :value="d">{{ d }}</option>
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
        新建职位
      </button>
    </div>

    <!-- 表格卡片 -->
    <div class="overflow-hidden rounded-lg border border-line bg-white">
      <div class="grid grid-cols-[1fr_120px_110px_120px_130px_56px] items-center border-b border-divider bg-[#FAFBFC] px-5 py-2.5 text-[11.5px] font-medium text-t3">
        <div>职位</div>
        <div>招聘进度</div>
        <div>状态</div>
        <div>负责人</div>
        <div>更新时间</div>
        <div>操作</div>
      </div>

      <div v-if="loading" class="px-5 py-12 text-center text-sm text-t4">加载中…</div>
      <div v-else-if="errorMsg" class="px-5 py-12 text-center text-sm text-danger">{{ errorMsg }}</div>
      <div v-else-if="visibleRows.length === 0" class="px-5 py-12 text-center text-sm text-t4">
        {{ records.length === 0 ? '暂无职位，点击右上角「新建职位」创建' : '当前筛选条件下无匹配职位' }}
      </div>

      <div
        v-for="row in visibleRows"
        :key="row.id"
        class="grid min-h-16 cursor-pointer grid-cols-[1fr_120px_110px_120px_130px_56px] items-center gap-5 border-b border-divider px-5 text-[13px] text-t2 transition last:border-b-0 hover:bg-[#FAFBFC]"
        @click="openDetail(row)"
      >
        <div class="min-w-0">
          <div class="truncate text-[13px] font-semibold text-t1">{{ row.title }}</div>
          <div class="mt-0.5 truncate text-[11.5px] text-t4">
            {{ row.deptName }}<template v-if="row.location"> · {{ row.location }}</template>
          </div>
        </div>
        <div class="text-[13px] font-semibold text-t1">
          {{ row.headcountFilled }}<span class="font-normal text-t4">/{{ row.headcountTotal }}</span>
        </div>
        <div>
          <span class="rounded px-2 py-0.5 text-[11.5px] font-medium" :class="STATUS_CHIP_CLASS[row.status]">
            {{ STATUS_LABELS[row.status] }}
          </span>
        </div>
        <div class="text-[12.5px] text-t3">—</div>
        <div class="text-[12.5px] text-t3">{{ formatUtcIso(row.updatedAt) }}</div>
        <div>
          <button
            v-if="row.status === 'draft'"
            class="text-[12.5px] font-medium text-primary transition hover:opacity-70"
            @click.stop="openEdit(row)"
          >
            编辑
          </button>
          <button v-else class="text-[12.5px] font-medium text-primary transition hover:opacity-70" @click.stop="openDetail(row)">
            查看
          </button>
        </div>
      </div>

      <!-- 分页 -->
      <div class="flex h-[52px] items-center justify-between border-t border-divider px-5">
        <span class="text-xs text-t3">共 {{ total }} 个职位</span>
        <div class="flex items-center gap-2">
          <button
            class="h-[26px] rounded-md px-2.5 text-[12.5px] text-t3 transition hover:bg-hover disabled:opacity-40"
            :disabled="current <= 1 || loading"
            @click="prevPage"
          >
            上一页
          </button>
          <span class="text-[12.5px] text-t3">{{ current }} / {{ pages }}</span>
          <button
            class="h-[26px] rounded-md px-2.5 text-[12.5px] text-t3 transition hover:bg-hover disabled:opacity-40"
            :disabled="current >= pages || loading"
            @click="nextPage"
          >
            下一页
          </button>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑抽屉 -->
    <HrRequestFormDialog
      :visible="formVisible"
      :mode="formMode"
      :initial="formInitial"
      @close="formVisible = false"
      @saved="onFormSaved"
    />
  </AppShell>
</template>
