<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { bindPlatformJob } from '@/lib/api/publish-record.api';
import { ApiError } from '@/lib/httpClient';
import type { PublishRecordVO } from '@/types/publish-record.types';

/**
 * 人工绑定 / 更正 / 解除平台岗位（路径 B，见设计文档 candidate-position-linking.md）。
 *
 * 这是路径 A（扩展在发布成功时自动捕获岗位 ID）的**兜底出口**：
 * A 依赖平台把岗位 ID 暴露给页面，拿不到时映射就为空、候选人投递永远归不了类。
 * 没有这个入口，A 一旦失效就没有任何补救手段。
 *
 * 交互取向（与项目其它页一致）：错误前置显眼；被硬拦截（409 岗位已被占用）后清空输入框，
 * 避免用户对着一个已经失败的值反复重试。
 */

const props = defineProps<{
  visible: boolean;
  record: PublishRecordVO | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved'): void;
}>();

const value = ref('');
const saving = ref(false);
const errorMsg = ref('');
const noticeMsg = ref('');

/** 只有已发布的台账才有对应的平台岗位（后端同约束，这里提前告知而不是等 400） */
const bindable = computed(() => props.record?.status === 'published');

const bindSourceLabel = computed(() => {
  const src = props.record?.platformJobBindSource;
  if (!props.record?.platformJobId) return '未关联';
  return src === 'manual' ? '人工绑定' : '自动捕获';
});

watch(
  () => [props.visible, props.record?.id] as const,
  () => {
    if (props.visible) {
      value.value = props.record?.platformJobId ?? '';
      errorMsg.value = '';
      noticeMsg.value = '';
    }
  },
  { immediate: true },
);

async function save(): Promise<void> {
  if (!props.record) return;
  const target = value.value.trim();
  if (!target) {
    errorMsg.value = '请填写平台岗位 ID；若要取消关联请点「解除绑定」';
    return;
  }
  saving.value = true;
  errorMsg.value = '';
  noticeMsg.value = '';
  try {
    await bindPlatformJob(props.record.id, target);
    noticeMsg.value = '已保存。该岗位下已采集候选人的投递归属已同步刷新。';
    emit('saved');
  } catch (e) {
    if (e instanceof ApiError) {
      errorMsg.value = e.message;
      // 409 = 该岗位已被别的台账占用。值本身是无效的，清空输入框，
      // 避免用户对着一个注定失败的值反复点保存。
      if (e.code === 409) value.value = '';
    } else {
      errorMsg.value = '保存失败，请稍后重试';
    }
  } finally {
    saving.value = false;
  }
}

async function unbind(): Promise<void> {
  if (!props.record) return;
  saving.value = true;
  errorMsg.value = '';
  noticeMsg.value = '';
  try {
    await bindPlatformJob(props.record.id, null);
    value.value = '';
    noticeMsg.value = '已解除关联。该岗位下的投递将回落为「未归类」，可在候选人库中看到。';
    emit('saved');
  } catch (e) {
    errorMsg.value = e instanceof ApiError ? e.message : '解除失败，请稍后重试';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="visible">
    <div class="fixed inset-0 z-40 bg-black/40" @click="emit('close')"></div>
    <div class="fixed inset-y-0 right-0 z-50 flex w-[520px] max-w-full flex-col bg-white shadow-2xl">
      <div class="flex items-center justify-between px-8 pt-5 pb-4">
        <span class="text-[15px] font-semibold">关联平台岗位</span>
        <span v-if="record" class="font-mono text-xs text-t4">{{ record.requestNo ?? '—' }}</span>
      </div>

      <div class="flex flex-1 flex-col gap-4 overflow-y-auto px-8 pb-2">
        <!-- 当前状态：把「值 + 来源」都摆出来，让 HR 知道这是机器猜的还是人确认的 -->
        <div class="rounded-lg border border-line bg-[#FAFBFC] px-4 py-3 text-[12.5px]">
          <div class="flex items-center gap-2">
            <span class="text-t4">需求</span>
            <span class="text-t1">{{ record?.requestTitle ?? '—' }}</span>
          </div>
          <div class="mt-1.5 flex items-center gap-2">
            <span class="text-t4">渠道</span>
            <span class="text-t1">{{ record?.channelName ?? '—' }}</span>
          </div>
          <div class="mt-1.5 flex items-center gap-2">
            <span class="text-t4">当前绑定</span>
            <span v-if="record?.platformJobId" class="font-mono text-t1">{{ record.platformJobId }}</span>
            <span v-else class="text-warning">未关联</span>
            <span class="text-t4">·</span>
            <span class="text-t3">{{ bindSourceLabel }}</span>
          </div>
        </div>

        <!-- 不可绑定的原因要显眼前置，而不是等后端 400 回来 -->
        <div
          v-if="!bindable"
          class="rounded-lg border border-[#F0D5A8] bg-[#FEF6E7] px-4 py-3 text-[12.5px] text-[#8A5A00]"
        >
          该台账当前状态为「{{ record?.status ?? '—' }}」，只有<b>已发布</b>的台账才对应平台上的真实岗位。
          若实际已发布但系统没检测到成功信号，请先在扩展面板把该台账标记为已发布，再回来关联。
        </div>

        <div>
          <label class="mb-1.5 block text-[12.5px] font-medium text-t2">平台岗位 ID</label>
          <input
            v-model="value"
            class="h-9 w-full rounded-md border border-line px-3 font-mono text-[13px] focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:bg-page"
            placeholder="如 575500411（BOSS 职位 ID）"
            :disabled="!bindable || saving"
            @keyup.enter="save"
          />
          <p class="mt-1.5 text-[11.5px] leading-relaxed text-t4">
            在 BOSS 侧打开该岗位的详情/管理页，从地址栏或职位信息里取职位 ID；
            也可在候选人详情里查看采集到的「平台岗位」值作为对照。
          </p>
        </div>

        <!-- 错误前置显眼；成功提示用绿色区分，避免与错误混作一谈 -->
        <div
          v-if="errorMsg"
          class="rounded-lg border border-[#F5C4B3] bg-[#FDECEB] px-4 py-3 text-[12.5px] text-[#A32D2D]"
        >
          {{ errorMsg }}
        </div>
        <div
          v-if="noticeMsg"
          class="rounded-lg border border-[#9FE1CB] bg-[#EAF6EF] px-4 py-3 text-[12.5px] text-[#0F6E56]"
        >
          {{ noticeMsg }}
        </div>

        <p class="text-[11.5px] leading-relaxed text-t4">
          绑定后，该岗位下已采集候选人的投递归属会被<b>级联刷新</b>；
          更正绑定同样会刷新旧岗位与新岗位两侧，不会留下两边不一致的残留。
        </p>
      </div>

      <div class="flex items-center justify-between gap-3 border-t border-divider px-8 py-4">
        <button
          v-if="record?.platformJobId"
          class="rounded-md border border-line px-3.5 py-2 text-[12.5px] text-t3 transition hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="saving"
          @click="unbind"
        >
          解除绑定
        </button>
        <span v-else></span>
        <div class="flex items-center gap-2">
          <button
            class="rounded-md border border-line px-4 py-2 text-[12.5px] text-t2 transition hover:bg-hover"
            :disabled="saving"
            @click="emit('close')"
          >
            关闭
          </button>
          <button
            class="rounded-md bg-primary px-4 py-2 text-[12.5px] font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!bindable || saving"
            @click="save"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
