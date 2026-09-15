<script setup lang="ts">
import { ref, watch } from 'vue';

import { createChannel, updateChannel } from '@/lib/api/channel.api';
import { ApiError } from '@/lib/httpClient';
import {
  CAPABILITY_OPTIONS,
  ChannelSavePayloadSchema,
  type ChannelSavePayload,
  type ChannelVO,
} from '@/types/channel.types';

/**
 * 渠道新建 / 编辑抽屉（设计语言对齐 HrRequestFormDialog）。
 * code 创建后不可修改（后端同约束）；fieldMapJson 以 JSON 文本编辑。
 */

const props = defineProps<{
  visible: boolean;
  mode: 'create' | 'edit';
  initial: ChannelVO | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', vo: ChannelVO): void;
}>();

interface FormState {
  code: string;
  name: string;
  publishUrlPattern: string;
  fieldMapJson: string;
  deepLinkTemplate: string;
  capability: string;
  status: string;
  sortOrder: string | number;
  remark: string;
}

const emptyForm = (): FormState => ({
  code: '',
  name: '',
  publishUrlPattern: '',
  fieldMapJson: '{\n  "fields": [\n    { "key": "title", "match": ["职位名称"], "type": "input" }\n  ]\n}',
  deepLinkTemplate: '',
  capability: 'manual',
  status: 'enabled',
  sortOrder: '0',
  remark: '',
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
      const c = props.initial;
      next.code = c.code;
      next.name = c.name;
      next.publishUrlPattern = c.publishUrlPattern ?? '';
      next.fieldMapJson = c.fieldMapJson ? JSON.stringify(c.fieldMapJson, null, 2) : '{}';
      next.deepLinkTemplate = c.deepLinkTemplate ?? '';
      next.capability = c.capability;
      next.status = c.status;
      next.sortOrder = String(c.sortOrder);
      next.remark = c.remark ?? '';
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

function toPayload(): ChannelSavePayload {
  return {
    code: form.value.code.trim(),
    name: form.value.name.trim(),
    publishUrlPattern: form.value.publishUrlPattern.trim() === '' ? null : form.value.publishUrlPattern.trim(),
    fieldMapJson: form.value.fieldMapJson,
    deepLinkTemplate: form.value.deepLinkTemplate.trim() === '' ? null : form.value.deepLinkTemplate.trim(),
    capability: form.value.capability as ChannelSavePayload['capability'],
    status: form.value.status as ChannelSavePayload['status'],
    sortOrder: num(form.value.sortOrder) ?? 0,
    remark: form.value.remark.trim() === '' ? null : form.value.remark.trim(),
  };
}

/** 前置 JSON 校验：必须是合法 JSON 对象（数组 / 标量 / 解析失败均拦截） */
function validateFieldMap(): string | null {
  const raw = form.value.fieldMapJson.trim();
  if (raw === '') return '字段映射配置不能为空';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '字段映射不是合法的 JSON';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return '字段映射必须是 JSON 对象（如 {"fields":[...]}）';
  }
  return null;
}

async function save(): Promise<void> {
  if (saving.value) return;
  const jsonError = validateFieldMap();
  if (jsonError) {
    formError.value = jsonError;
    return;
  }
  const payload = toPayload();
  const parsed = ChannelSavePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    formError.value = parsed.error.issues[0]?.message ?? '表单参数有误';
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    const vo =
      props.mode === 'edit' && props.initial
        ? await updateChannel(props.initial.id, parsed.data)
        : await createChannel(parsed.data);
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
          {{ mode === 'create' ? '新建渠道' : '编辑渠道' }}
        </span>
        <span v-if="mode === 'edit' && initial" class="text-xs text-t4">{{ initial.code }}</span>
      </div>

      <div class="flex flex-1 flex-col gap-4 overflow-y-auto px-10 pb-2">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">渠道代码 <span class="text-danger">*</span></label>
            <input
              v-model="form.code"
              class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:bg-page disabled:text-t4"
              placeholder="如：boss"
              :disabled="mode === 'edit'"
            />
            <p v-if="mode === 'edit'" class="mt-1 text-[11px] text-t4">渠道代码创建后不可修改</p>
          </div>
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">渠道名称 <span class="text-danger">*</span></label>
            <input v-model="form.name" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="如：BOSS 直聘" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">发布能力 <span class="text-danger">*</span></label>
            <select v-model="form.capability" class="h-9 w-full rounded-md border border-line bg-white px-3 text-[13px] focus:border-primary focus:outline-none">
              <option v-for="o in CAPABILITY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">状态 <span class="text-danger">*</span></label>
            <select v-model="form.status" class="h-9 w-full rounded-md border border-line bg-white px-3 text-[13px] focus:border-primary focus:outline-none">
              <option value="enabled">启用（参与草稿渲染）</option>
              <option value="disabled">停用（不渲染新草稿）</option>
            </select>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">展示排序</label>
            <input v-model="form.sortOrder" type="number" min="0" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" />
          </div>
          <div>
            <label class="mb-1.5 block text-[12.5px] font-medium text-t2">发布页 URL 模式</label>
            <input v-model="form.publishUrlPattern" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="如：https://www.zhipin.com/*" />
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">投递深链模板</label>
          <input v-model="form.deepLinkTemplate" class="h-9 w-full rounded-md border border-line px-3 text-[13px] focus:border-primary focus:outline-none" placeholder="https://apply.example.com/jobs/{requestNo}" />
          <p class="mt-1 text-[11px] text-t4">支持 {requestNo} 占位符，渲染草稿时替换为需求单编号</p>
        </div>

        <div>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">字段映射配置 <span class="text-danger">*</span></label>
          <textarea
            v-model="form.fieldMapJson"
            rows="8"
            class="w-full rounded-md border border-line px-3 py-2 font-mono text-[12px] leading-relaxed focus:border-primary focus:outline-none"
            placeholder='{"fields":[{"key":"title","match":["职位名称"],"type":"input"}]}'
          ></textarea>
          <p class="mt-1 text-[11px] text-t4">JSON 对象：fields[].key / match / type 描述发布页字段与平台字段映射，扩展端按此填充</p>
        </div>

        <div>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">备注</label>
          <textarea v-model="form.remark" rows="2" class="w-full rounded-md border border-line px-3 py-2 text-[13px] leading-relaxed focus:border-primary focus:outline-none" placeholder="渠道用途、对接说明等（可选）"></textarea>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2.5 border-t border-divider px-10 py-4">
        <p v-if="formError" class="mr-auto text-xs text-danger">{{ formError }}</p>
        <button class="h-9 rounded-md border border-line px-4 text-[13px] text-t2 transition hover:border-t4" @click="emit('close')">取消</button>
        <button
          class="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
