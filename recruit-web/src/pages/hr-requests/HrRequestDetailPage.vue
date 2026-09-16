<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  approveHrRequest,
  closeHrRequest,
  fetchHrRequest,
  rejectHrRequest,
  reopenHrRequest,
  submitHrRequest,
  updateHeadcount,
} from '@/lib/api/hr-request.api';
import { fetchDraftsByRequest } from '@/lib/api/publish-draft.api';
import { ApiError } from '@/lib/httpClient';
import { formatUtcIso } from '@/lib/utils';
import AppShell from '@/components/layout/AppShell.vue';
import {
  CLOSE_REASON_LABELS,
  CLOSE_REASON_OPTIONS,
  EDUCATION_OPTIONS,
  EMPLOYMENT_TYPE_LABELS,
  STATUS_LABELS,
} from '@/types/hr-request.types';
import {
  DRAFT_STATUS_LABELS,
  FIELD_LABELS,
  type PublishDraftVO,
} from '@/types/publish-draft.types';
import { formatSalary, STATUS_CHIP_CLASS } from '../hr-requests/hr-request-ui';
import HrRequestFormDialog from '../hr-requests/HrRequestFormDialog.vue';
import type { HrRequestVO } from '@/types/hr-request.types';

/**
 * 职位详情页（对齐原型 s4-job-pipeline 布局）：
 * 信息卡 + 状态机操作 + 渠道发布草稿（T3.2 产物）+ JD + 候选人管线占位。
 */

const route = useRoute();
const router = useRouter();

const requestId = computed(() => String(route.params.id ?? ''));
const r = ref<HrRequestVO | null>(null);
const drafts = ref<PublishDraftVO[]>([]);
const loading = ref(true);
const loadError = ref('');

type PromptKind = 'reject' | 'close' | 'headcount';
const prompt = ref<PromptKind | null>(null);
const rejectReason = ref('');
const closeReason = ref<'filled' | 'cancelled' | 'frozen'>('cancelled');
const headcountFilled = ref('0');
const busy = ref(false);
const actionError = ref('');
const copiedDraftId = ref('');

const editVisible = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    r.value = await fetchHrRequest(requestId.value);
    drafts.value = await fetchDraftsByRequest(requestId.value);
    if (prompt.value === null) {
      rejectReason.value = '';
      closeReason.value = 'cancelled';
      headcountFilled.value = String(r.value.headcountFilled);
    }
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

function educationLabel(v: string | null): string {
  return EDUCATION_OPTIONS.find((o) => o.value === v)?.label ?? '不限';
}

function employmentLabel(v: string | null): string {
  const key = v as keyof typeof EMPLOYMENT_TYPE_LABELS | null;
  return key ? (EMPLOYMENT_TYPE_LABELS[key] ?? '—') : '—';
}

function closeReasonLabel(v: string | null): string {
  const key = v as keyof typeof CLOSE_REASON_LABELS | null;
  return key ? (CLOSE_REASON_LABELS[key] ?? v) : '';
}

async function run(fn: () => Promise<HrRequestVO>): Promise<void> {
  if (busy.value || !r.value) return;
  busy.value = true;
  actionError.value = '';
  try {
    r.value = await fn();
    prompt.value = null;
    drafts.value = await fetchDraftsByRequest(requestId.value);
  } catch (e) {
    actionError.value = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
    // 409 = 乐观并发控制未命中（状态已被他人改变）：立即重载，否则界面停留在过期状态、再点仍是 409
    if (e instanceof ApiError && e.code === 409) {
      await load();
    }
  } finally {
    busy.value = false;
  }
}

function doSubmit(): void {
  if (r.value) void run(() => submitHrRequest(r.value!.id));
}
function doApprove(): void {
  if (r.value) void run(() => approveHrRequest(r.value!.id));
}
function doReopen(): void {
  if (r.value) void run(() => reopenHrRequest(r.value!.id));
}
function confirmReject(): void {
  const reason = rejectReason.value.trim();
  if (reason === '') {
    actionError.value = '驳回原因不能为空';
    return;
  }
  if (r.value) void run(() => rejectHrRequest(r.value!.id, { rejectReason: reason }));
}
function confirmClose(): void {
  if (r.value) void run(() => closeHrRequest(r.value!.id, { closeReason: closeReason.value }));
}
function confirmHeadcount(): void {
  const n = Number(headcountFilled.value);
  if (!Number.isInteger(n) || n < 0) {
    actionError.value = '已入职数必须是不小于 0 的整数';
    return;
  }
  if (r.value) void run(() => updateHeadcount(r.value!.id, { headcountFilled: n }));
}

function onEditSaved(vo: HrRequestVO): void {
  editVisible.value = false;
  r.value = vo;
}

async function copyDeepLink(draft: PublishDraftVO): Promise<void> {
  if (!draft.deepLink) return;
  try {
    await navigator.clipboard.writeText(draft.deepLink);
    copiedDraftId.value = draft.id;
    setTimeout(() => {
      if (copiedDraftId.value === draft.id) copiedDraftId.value = '';
    }, 1600);
  } catch {
    actionError.value = '复制失败，请手动选择深链文本';
  }
}

/** fields_json 摘要：白名单字段中文标签 + 值（长文本截断） */
function draftFieldSummary(draft: PublishDraftVO): string {
  const fields = draft.fieldsJson ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    const label = FIELD_LABELS[key] ?? key;
    const text = String(value).replace(/\\s+/g, ' ');
    parts.push(`${label}：${text.length > 18 ? text.slice(0, 18) + '…' : text}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function goBack(): void {
  void router.push({ name: 'hr-requests' });
}

/** 候选人管线看板列（T5 候选人模块上线前占位） */
const PIPELINE_STAGES: ReadonlyArray<{ label: string; success?: boolean }> = [
  { label: '推荐池' },
  { label: '一面' },
  { label: '二面' },
  { label: '待定' },
  { label: '已录用', success: true },
];
</script>

<template>
  <AppShell :title="r?.title ?? '职位详情'" crumb="职位">
    <div v-if="loading" class="py-20 text-center text-sm text-t4">加载中…</div>
    <div v-else-if="loadError" class="py-20 text-center text-sm text-danger">
      {{ loadError }}
      <button class="ml-3 text-primary hover:underline" @click="goBack">返回职位列表</button>
    </div>

    <template v-else-if="r">
      <!-- 信息卡 -->
      <div class="rounded-lg border border-line bg-white">
        <div class="flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
          <div class="flex min-w-0 items-center gap-2.5">
            <h1 class="truncate text-[17px] font-semibold tracking-tight">{{ r.title }}</h1>
            <span class="shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium" :class="STATUS_CHIP_CLASS[r.status]">
              {{ STATUS_LABELS[r.status] }}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-2.5">
            <button
              v-if="r.status === 'draft'"
              class="h-[34px] rounded-md border border-line px-3.5 text-[12.5px] text-t2 transition hover:border-primary hover:text-primary"
              @click="editVisible = true"
            >
              编辑职位
            </button>
            <button
              v-if="r.status === 'draft'"
              class="h-[34px] rounded-md bg-primary px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              :disabled="busy"
              @click="doSubmit"
            >
              提交审批
            </button>
            <template v-else-if="r.status === 'pending_approval'">
              <button
                class="h-[34px] rounded-md border border-line px-3.5 text-[12.5px] text-danger transition hover:border-danger"
                @click="prompt = prompt === 'reject' ? null : 'reject'"
              >
                驳回
              </button>
              <button
                class="h-[34px] rounded-md bg-primary px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                :disabled="busy"
                @click="doApprove"
              >
                审批通过
              </button>
            </template>
            <template v-else-if="r.status === 'open'">
              <button
                class="h-[34px] rounded-md border border-line px-3.5 text-[12.5px] text-t2 transition hover:border-primary hover:text-primary"
                @click="prompt = prompt === 'headcount' ? null : 'headcount'"
              >
                修正入职数
              </button>
              <button
                class="h-[34px] rounded-md border border-line px-3.5 text-[12.5px] text-danger transition hover:border-danger"
                @click="prompt = prompt === 'close' ? null : 'close'"
              >
                关闭需求
              </button>
            </template>
            <button
              v-else
              class="h-[34px] rounded-md border border-line px-3.5 text-[12.5px] text-t2 transition hover:border-primary hover:text-primary disabled:opacity-50"
              :disabled="busy"
              @click="doReopen"
            >
              重新打开
            </button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-5 py-4 text-[12.5px] text-t3">
          <span>{{ r.deptName }}<template v-if="r.location"> · {{ r.location }}</template></span>
          <span>招聘 <b class="font-semibold text-t2">{{ r.headcountTotal }}</b> 人 · 已入职 <b class="font-semibold text-t2">{{ r.headcountFilled }}</b></span>
          <span>薪资 <b class="font-semibold text-t2">{{ formatSalary(r.salaryMin, r.salaryMax) }}</b></span>
          <span>学历 {{ educationLabel(r.education) }}</span>
          <span>年限 {{ r.experienceYears != null ? `${r.experienceYears} 年起` : '不限' }}</span>
          <span>{{ employmentLabel(r.employmentType) }}</span>
          <span class="ml-auto">{{ r.requestNo }} · 创建于 {{ formatUtcIso(r.createdAt) }}</span>
        </div>
      </div>

      <!-- 带输入的流转操作 -->
      <div v-if="prompt" class="rounded-lg border border-line bg-white p-5">
        <template v-if="prompt === 'reject'">
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">驳回原因</label>
          <textarea v-model="rejectReason" rows="2" class="w-full rounded-md border border-line px-3 py-2 text-[13px] focus:border-primary focus:outline-none" placeholder="说明驳回原因（必填）"></textarea>
        </template>
        <template v-else-if="prompt === 'close'">
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">关闭原因</label>
          <select v-model="closeReason" class="h-9 w-full rounded-md border border-line bg-white px-3 text-[13px] focus:border-primary focus:outline-none">
            <option v-for="o in CLOSE_REASON_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </template>
        <template v-else>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">已入职数（当前 {{ r.headcountFilled }} / 计划 {{ r.headcountTotal }}）</label>
          <input v-model="headcountFilled" type="number" min="0" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" />
          <p class="mt-1 text-[11.5px] text-t4">招满自动关闭{{ r.autoClose ? '已开启' : '已关闭' }}{{ r.autoClose ? '，入职数达到计划人数将自动关闭需求' : '' }}</p>
        </template>
        <div class="mt-3 flex justify-end gap-2.5">
          <p v-if="actionError" class="mr-auto self-center text-xs text-danger">{{ actionError }}</p>
          <button class="h-8 rounded-md border border-line px-3 text-xs text-t2 hover:border-t4" @click="prompt = null">取消</button>
          <button
            v-if="prompt === 'reject'"
            class="h-8 rounded-md bg-danger px-3 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            :disabled="busy"
            @click="confirmReject"
          >
            确认驳回
          </button>
          <button
            v-else-if="prompt === 'close'"
            class="h-8 rounded-md bg-danger px-3 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            :disabled="busy"
            @click="confirmClose"
          >
            确认关闭
          </button>
          <button
            v-else
            class="h-8 rounded-md bg-primary px-3 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            :disabled="busy"
            @click="confirmHeadcount"
          >
            确认修正
          </button>
        </div>
      </div>

      <p v-if="actionError && !prompt" class="text-xs text-danger">{{ actionError }}</p>
      <div v-if="r.rejectReason" class="rounded-md bg-warning-tint px-4 py-2.5 text-[12.5px] text-warning">
        最近驳回原因：{{ r.rejectReason }}
      </div>
      <div v-if="r.status === 'closed'" class="rounded-md bg-divider px-4 py-2.5 text-[12.5px] text-t2">
        已关闭（{{ closeReasonLabel(r.closeReason) }}）{{ r.closedAt ? ` · ${formatUtcIso(r.closedAt)}` : '' }}
      </div>

      <!-- 渠道发布草稿（T3.2） -->
      <div class="rounded-lg border border-line bg-white">
        <div class="flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
          <span class="text-[13.5px] font-semibold">渠道发布</span>
          <span class="text-[11.5px] text-t4">审批通过后自动为启用渠道生成发布草稿，关闭时未发布草稿自动取消</span>
        </div>
        <div v-if="drafts.length === 0" class="px-5 py-10 text-center text-sm text-t4">
          暂无发布草稿{{ r.status === 'draft' || r.status === 'pending_approval' ? '，审批通过后自动生成' : '' }}
        </div>
        <div
          v-for="draft in drafts"
          :key="draft.id"
          class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-divider px-5 py-3.5 last:border-b-0 hover:bg-[#FAFBFC]"
        >
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-semibold">{{ draft.channelName ?? draft.channelCode ?? '未知渠道' }}</span>
                <span class="rounded px-1.5 py-0.5 text-[10.5px] font-medium" :class="draft.status === 'pending' ? 'bg-primary-tint text-primary' : draft.status === 'consumed' ? 'bg-success-tint text-success' : 'bg-divider text-t4'">
                  {{ DRAFT_STATUS_LABELS[draft.status] }}
                </span>
              </div>
              <p class="mt-0.5 truncate text-[11.5px] text-t4">{{ draftFieldSummary(draft) }}</p>
            </div>
          </div>
          <code v-if="draft.deepLink" class="max-w-[300px] truncate rounded bg-page px-2 py-1 text-[11px] text-t3" :title="draft.deepLink">{{ draft.deepLink }}</code>
          <button v-if="draft.deepLink" class="h-7 shrink-0 rounded-md border border-line px-2.5 text-xs text-primary transition hover:border-primary" @click="copyDeepLink(draft)">
            {{ copiedDraftId === draft.id ? '已复制' : '复制深链' }}
          </button>
        </div>
      </div>

      <!-- JD -->
      <div class="rounded-lg border border-line bg-white">
        <div class="border-b border-divider px-5 py-3.5 text-[13.5px] font-semibold">职位描述</div>
        <div class="flex flex-col gap-4 px-5 py-4">
          <p class="whitespace-pre-wrap text-[12.5px] leading-7 text-t2">{{ r.jobDescription }}</p>
          <div v-if="r.jobRequirement">
            <h3 class="mb-1.5 text-[13px] font-semibold">任职要求</h3>
            <p class="whitespace-pre-wrap text-[12.5px] leading-7 text-t2">{{ r.jobRequirement }}</p>
          </div>
        </div>
      </div>

      <!-- 候选人管线（占位） -->
      <div class="grid grid-cols-5 gap-3">
        <div
          v-for="stage in PIPELINE_STAGES"
          :key="stage.label"
          class="min-h-[240px] rounded-lg p-2.5"
          :class="stage.success ? 'bg-success-tint' : 'bg-[#F1F2F4]'"
        >
          <div class="flex items-center justify-between px-1 pb-2.5">
            <span class="text-[12.5px] font-semibold" :class="stage.success ? 'text-success' : ''">{{ stage.label }}</span>
            <span class="text-xs text-t4">0</span>
          </div>
          <div class="flex flex-col gap-2">
            <div class="rounded-md border border-dashed border-line bg-white/60 px-3 py-6 text-center text-[11px] text-t4">
              候选人模块建设中
            </div>
          </div>
        </div>
      </div>
    </template>

    <HrRequestFormDialog
      :visible="editVisible"
      mode="edit"
      :initial="r"
      @close="editVisible = false"
      @saved="onEditSaved"
    />
  </AppShell>
</template>
