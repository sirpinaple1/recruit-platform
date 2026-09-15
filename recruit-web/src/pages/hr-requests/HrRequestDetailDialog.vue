<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  approveHrRequest,
  closeHrRequest,
  rejectHrRequest,
  reopenHrRequest,
  submitHrRequest,
  updateHeadcount,
} from '@/lib/api/hr-request.api';
import { ApiError } from '@/lib/httpClient';
import { formatUtcIso } from '@/lib/utils';
import {
  CLOSE_REASON_LABELS,
  CLOSE_REASON_OPTIONS,
  EDUCATION_OPTIONS,
  EMPLOYMENT_TYPE_LABELS,
  STATUS_LABELS,
  type HrRequestVO,
} from '@/types/hr-request.types';
import { formatSalary, STATUS_CHIP_CLASS } from './hr-request-ui';

/**
 * 需求单详情弹窗：按状态展示流转操作（状态机见后端 HrRequestService）。
 * 业务失败（如非法转移）以红字提示，不关弹窗。
 */

const props = defineProps<{
  visible: boolean;
  request: HrRequestVO | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'updated', vo: HrRequestVO): void;
  (e: 'edit', vo: HrRequestVO): void;
}>();

type PromptKind = 'reject' | 'close' | 'headcount';

const prompt = ref<PromptKind | null>(null);
const rejectReason = ref('');
const closeReason = ref<'filled' | 'cancelled' | 'frozen'>('cancelled');
const headcountFilled = ref('0');
const busy = ref(false);
const actionError = ref('');

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    prompt.value = null;
    actionError.value = '';
    if (props.request) {
      rejectReason.value = '';
      closeReason.value = 'cancelled';
      headcountFilled.value = String(props.request.headcountFilled);
    }
  },
);

const r = computed(() => props.request);

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
    const vo = await fn();
    prompt.value = null;
    emit('updated', vo);
  } catch (e) {
    actionError.value = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
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
</script>

<template>
  <div v-if="visible && r">
    <div class="fixed inset-0 z-40 bg-black/40" @click="emit('close')"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div class="flex max-h-[88vh] w-[640px] flex-col rounded-[10px] bg-white shadow-2xl">
        <!-- 头部 -->
        <div class="flex items-start justify-between px-7 pt-5 pb-4">
          <div>
            <div class="flex items-center gap-2.5">
              <h2 class="text-[15px] font-semibold">{{ r.title }}</h2>
              <span class="rounded-sm px-2 py-0.5 text-xs font-medium" :class="STATUS_CHIP_CLASS[r.status]">
                {{ STATUS_LABELS[r.status] }}
              </span>
            </div>
            <p class="mt-1 text-xs text-t4">{{ r.requestNo }} · 创建于 {{ formatUtcIso(r.createdAt) }}</p>
          </div>
          <button class="rounded-md px-2 py-1 text-lg leading-none text-t4 transition hover:bg-divider hover:text-t2" @click="emit('close')">×</button>
        </div>

        <!-- 内容 -->
        <div class="flex flex-1 flex-col gap-4 overflow-y-auto border-t border-divider px-7 py-5">
          <div class="grid grid-cols-2 gap-x-10 gap-y-2.5 text-[12.5px]">
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">用人部门</span><span>{{ r.deptName }}</span></div>
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">工作地点</span><span>{{ r.location || '—' }}</span></div>
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">招聘进度</span><span>{{ r.headcountFilled }} / {{ r.headcountTotal }}</span></div>
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">薪资区间</span><span>{{ formatSalary(r.salaryMin, r.salaryMax) }}</span></div>
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">学历要求</span><span>{{ educationLabel(r.education) }}</span></div>
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">工作年限</span><span>{{ r.experienceYears != null ? `${r.experienceYears} 年起` : '不限' }}</span></div>
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">用工性质</span><span>{{ employmentLabel(r.employmentType) }}</span></div>
            <div class="flex gap-3"><span class="w-20 shrink-0 text-t3">招满自动关闭</span><span>{{ r.autoClose ? '开' : '关' }}</span></div>
          </div>

          <div v-if="r.rejectReason" class="rounded-md bg-warning-tint px-4 py-2.5 text-[12.5px] text-warning">
            最近驳回原因：{{ r.rejectReason }}
          </div>
          <div v-if="r.status === 'closed'" class="rounded-md bg-divider px-4 py-2.5 text-[12.5px] text-t2">
            已关闭（{{ closeReasonLabel(r.closeReason) }}）{{ r.closedAt ? ` · ${formatUtcIso(r.closedAt)}` : '' }}
          </div>
          <div v-if="r.status === 'open' && r.openedAt" class="text-xs text-t4">开放于 {{ formatUtcIso(r.openedAt) }}</div>

          <div>
            <h3 class="mb-1.5 text-[13px] font-semibold">JD 正文</h3>
            <p class="whitespace-pre-wrap rounded-md bg-page px-4 py-3 text-[12.5px] leading-relaxed text-t2">{{ r.jobDescription }}</p>
          </div>

          <div v-if="r.jobRequirement">
            <h3 class="mb-1.5 text-[13px] font-semibold">任职要求</h3>
            <p class="whitespace-pre-wrap rounded-md bg-page px-4 py-3 text-[12.5px] leading-relaxed text-t2">{{ r.jobRequirement }}</p>
          </div>

          <!-- 带输入的流转操作 -->
          <div v-if="prompt === 'reject'" class="rounded-md border border-line p-4">
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">驳回原因</label>
            <textarea v-model="rejectReason" rows="2" class="w-full rounded-md border border-line px-3 py-2 text-[13px] focus:border-primary focus:outline-none" placeholder="说明驳回原因（必填）"></textarea>
            <div class="mt-2.5 flex justify-end gap-2">
              <button class="h-8 rounded-md border border-line px-3 text-xs text-t2 hover:border-t4" @click="prompt = null">取消</button>
              <button class="h-8 rounded-md bg-danger px-3 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50" :disabled="busy" @click="confirmReject">确认驳回</button>
            </div>
          </div>

          <div v-if="prompt === 'close'" class="rounded-md border border-line p-4">
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">关闭原因</label>
            <select v-model="closeReason" class="h-9 w-full rounded-md border border-line bg-white px-3 text-[13px] focus:border-primary focus:outline-none">
              <option v-for="o in CLOSE_REASON_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <div class="mt-2.5 flex justify-end gap-2">
              <button class="h-8 rounded-md border border-line px-3 text-xs text-t2 hover:border-t4" @click="prompt = null">取消</button>
              <button class="h-8 rounded-md bg-danger px-3 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50" :disabled="busy" @click="confirmClose">确认关闭</button>
            </div>
          </div>

          <div v-if="prompt === 'headcount'" class="rounded-md border border-line p-4">
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">已入职数（当前 {{ r.headcountFilled }} / 计划 {{ r.headcountTotal }}）</label>
            <input v-model="headcountFilled" type="number" min="0" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" />
            <p class="mt-1 text-[11.5px] text-t4">招满自动关闭开启时，入职数达到计划人数将自动关闭需求</p>
            <div class="mt-2.5 flex justify-end gap-2">
              <button class="h-8 rounded-md border border-line px-3 text-xs text-t2 hover:border-t4" @click="prompt = null">取消</button>
              <button class="h-8 rounded-md bg-primary px-3 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50" :disabled="busy" @click="confirmHeadcount">确认修正</button>
            </div>
          </div>

          <p v-if="actionError" class="text-xs text-danger">{{ actionError }}</p>
        </div>

        <!-- 底部操作（按状态机） -->
        <div class="flex items-center justify-end gap-2.5 border-t border-divider px-7 py-4">
          <template v-if="r.status === 'draft'">
            <button class="h-9 rounded-md border border-line px-4 text-[13px] text-t2 transition hover:border-primary hover:text-primary" @click="emit('edit', r)">编辑</button>
            <button class="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-50" :disabled="busy" @click="doSubmit">提交审批</button>
          </template>
          <template v-else-if="r.status === 'pending_approval'">
            <button class="h-9 rounded-md border border-line px-4 text-[13px] text-danger transition hover:border-danger" @click="prompt = 'reject'">驳回</button>
            <button class="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-50" :disabled="busy" @click="doApprove">审批通过</button>
          </template>
          <template v-else-if="r.status === 'open'">
            <button class="h-9 rounded-md border border-line px-4 text-[13px] text-t2 transition hover:border-primary hover:text-primary" @click="prompt = 'headcount'">修正入职数</button>
            <button class="h-9 rounded-md border border-line px-4 text-[13px] text-danger transition hover:border-danger" @click="prompt = 'close'">关闭需求</button>
          </template>
          <template v-else>
            <button class="h-9 rounded-md border border-line px-4 text-[13px] text-t2 transition hover:border-primary hover:text-primary" :disabled="busy" @click="doReopen">重新打开</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
