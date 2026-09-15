<script setup lang="ts">
import { ref, watch } from 'vue';

import { createHrRequest, updateHrRequest } from '@/lib/api/hr-request.api';
import { ApiError } from '@/lib/httpClient';
import {
  EDUCATION_OPTIONS,
  EMPLOYMENT_TYPE_OPTIONS,
  HrRequestSavePayloadSchema,
  type HrRequestSavePayload,
  type HrRequestVO,
} from '@/types/hr-request.types';

/**
 * 需求单新建 / 编辑抽屉（对齐原型 s3 右侧 drawer）。
 * 编辑仅限 draft 状态（后端同约束）。
 */

const props = defineProps<{
  visible: boolean;
  mode: 'create' | 'edit';
  initial: HrRequestVO | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', vo: HrRequestVO): void;
}>();

interface FormState {
  title: string;
  deptName: string;
  /** type="number" 输入框的 v-model 会被 Vue 自动转成 number（looseToNumber） */
  headcountTotal: string | number;
  salaryMin: string | number;
  salaryMax: string | number;
  location: string;
  education: string;
  experienceYears: string | number;
  employmentType: string;
  jobDescription: string;
  jobRequirement: string;
  autoClose: boolean;
}

const emptyForm = (): FormState => ({
  title: '',
  deptName: '',
  headcountTotal: '1',
  salaryMin: '',
  salaryMax: '',
  location: '',
  education: '',
  experienceYears: '',
  employmentType: '',
  jobDescription: '',
  jobRequirement: '',
  autoClose: true,
});

const form = ref<FormState>(emptyForm());
const formError = ref('');
const saving = ref(false);

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    formError.value = '';
    const next = emptyForm();
    if (props.mode === 'edit' && props.initial) {
      const r = props.initial;
      next.title = r.title;
      next.deptName = r.deptName;
      next.headcountTotal = String(r.headcountTotal);
      next.salaryMin = r.salaryMin == null ? '' : String(r.salaryMin);
      next.salaryMax = r.salaryMax == null ? '' : String(r.salaryMax);
      next.location = r.location ?? '';
      next.education = r.education ?? '';
      next.experienceYears = r.experienceYears == null ? '' : String(r.experienceYears);
      next.employmentType = r.employmentType ?? '';
      next.jobDescription = r.jobDescription;
      next.jobRequirement = r.jobRequirement ?? '';
      next.autoClose = r.autoClose;
    }
    form.value = next;
  },
);

/** 空串转 null；非整数返回 NaN 由 schema 拦截。兼容 number：数字输入框 v-model 自动转型 */
function num(v: string | number): number | null {
  const t = String(v).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

function toPayload(): HrRequestSavePayload {
  return {
    title: form.value.title.trim(),
    deptName: form.value.deptName.trim(),
    headcountTotal: num(form.value.headcountTotal) ?? 1,
    jobDescription: form.value.jobDescription,
    jobRequirement: form.value.jobRequirement.trim() === '' ? null : form.value.jobRequirement,
    salaryMin: num(form.value.salaryMin),
    salaryMax: num(form.value.salaryMax),
    location: form.value.location.trim() === '' ? null : form.value.location.trim(),
    education: form.value.education === '' ? null : form.value.education,
    experienceYears: num(form.value.experienceYears),
    employmentType: form.value.employmentType === '' ? null : (form.value.employmentType as HrRequestSavePayload['employmentType']),
    autoClose: form.value.autoClose,
  };
}

async function save(): Promise<void> {
  if (saving.value) return;
  const payload = toPayload();
  const parsed = HrRequestSavePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    formError.value = parsed.error.issues[0]?.message ?? '表单参数有误';
    return;
  }
  if (payload.salaryMin != null && payload.salaryMax != null && payload.salaryMin > payload.salaryMax) {
    formError.value = '薪资下限不能大于上限';
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    const vo =
      props.mode === 'edit' && props.initial
        ? await updateHrRequest(props.initial.id, parsed.data)
        : await createHrRequest(parsed.data);
    emit('saved', vo);
  } catch (e) {
    formError.value = e instanceof ApiError ? e.message : '保存失败，请稍后重试';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="visible">
    <div class="fixed inset-0 z-40 bg-black/40" @click="emit('close')"></div>
    <div class="fixed inset-y-0 right-0 z-50 flex w-[580px] max-w-full flex-col bg-white shadow-2xl">
      <div class="flex items-center justify-between px-10 pt-5 pb-4">
        <span class="text-[15px] font-semibold">
          {{ mode === 'create' ? '新建需求单' : '编辑需求单' }}
        </span>
        <span v-if="mode === 'edit' && initial" class="text-xs text-t4">{{ initial.requestNo }}</span>
      </div>

      <div class="flex flex-1 flex-col gap-4 overflow-y-auto px-10 pb-2">
        <div>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">岗位名称 <span class="text-danger">*</span></label>
          <input v-model="form.title" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="如：Java 高级工程师" />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">用人部门 <span class="text-danger">*</span></label>
            <input v-model="form.deptName" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="如：基础平台部" />
          </div>
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">计划招聘人数 <span class="text-danger">*</span></label>
            <input v-model="form.headcountTotal" type="number" min="1" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">月薪下限（元）</label>
            <input v-model="form.salaryMin" type="number" min="0" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="15000" />
          </div>
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">月薪上限（元）</label>
            <input v-model="form.salaryMax" type="number" min="0" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="25000" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">工作地点</label>
            <input v-model="form.location" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="如：深圳" />
          </div>
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">要求工作年限</label>
            <input v-model="form.experienceYears" type="number" min="0" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="如：3" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">学历要求</label>
            <select v-model="form.education" class="h-9 w-full rounded-md border border-line bg-white px-3 text-[13px] focus:border-primary focus:outline-none">
              <option value="">不限</option>
              <option v-for="o in EDUCATION_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">用工性质</label>
            <select v-model="form.employmentType" class="h-9 w-full rounded-md border border-line bg-white px-3 text-[13px] focus:border-primary focus:outline-none">
              <option value="">未指定</option>
              <option v-for="o in EMPLOYMENT_TYPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">JD 正文 <span class="text-danger">*</span></label>
          <textarea v-model="form.jobDescription" rows="6" class="w-full rounded-md border border-line px-3 py-2 text-[13px] leading-relaxed focus:border-primary focus:outline-none" placeholder="岗位职责、工作内容等公开信息（将用于渠道发布预填充）"></textarea>
        </div>

        <div>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">任职要求</label>
          <textarea v-model="form.jobRequirement" rows="4" class="w-full rounded-md border border-line px-3 py-2 text-[13px] leading-relaxed focus:border-primary focus:outline-none" placeholder="技能要求、素质要求等（可选）"></textarea>
        </div>

        <label class="flex cursor-pointer items-center gap-2 text-[12.5px] text-t2">
          <input v-model="form.autoClose" type="checkbox" class="size-4 accent-[#2d5be3]" />
          招满自动关闭（入职数达到计划人数时自动关闭需求）
        </label>
      </div>

      <div class="flex items-center justify-end gap-2.5 border-t border-divider px-10 py-4">
        <p v-if="formError" class="mr-auto text-xs text-danger">{{ formError }}</p>
        <button class="h-9 rounded-md border border-line px-4 text-[13px] text-t2 transition hover:border-t4" @click="emit('close')">取消</button>
        <button
          class="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : mode === 'create' ? '保存草稿' : '保存修改' }}
        </button>
      </div>
    </div>
  </div>
</template>
