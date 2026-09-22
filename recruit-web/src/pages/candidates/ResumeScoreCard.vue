<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { fetchCandidateScores, rescoreCandidate } from '@/lib/api/candidate.api';
import { ApiError } from '@/lib/httpClient';
import { cn, formatUtcIso } from '@/lib/utils';
import { useToast } from '@/composables/useToast';
import {
  RECOMMENDATION_LABELS,
  SCORE_TYPE_LABELS,
  type ResumeScoreVO,
} from '@/types/candidate.types';

/**
 * LLM 打分卡：候选人简历的打分结果展示 + 手动重打。
 *
 * 打分是采集落库后异步执行的（事务提交后事件触发），所以这里要处理三种行态：
 * pending（打分中，轮询等结果）/ success（分数+维度+亮点风险）/ failed（原因+重试）。
 * 抽成独立组件是因为 CandidateDetailDialog 已逼近行数上限。
 */

const props = defineProps<{ candidateId: string }>();

const toast = useToast();

const loading = ref(true);
const errorMsg = ref('');
const scores = ref<ResumeScoreVO[]>([]);
const rescoring = ref(false);

const hasPending = computed(() => scores.value.some((s) => s.status === 'pending'));

let pollTimer: number | null = null;

/** 有 pending 行就轮询（5s），全部终态即停；弹窗关闭由 onBeforeUnmount 兜底清理 */
function startPoll(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (!hasPending.value) {
      stopPoll();
      return;
    }
    void load();
  }, 5000);
}

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function load(): Promise<void> {
  try {
    scores.value = await fetchCandidateScores(props.candidateId);
    errorMsg.value = '';
  } catch (e) {
    // 轮询期间失败：已有旧数据就静默保留，别把整卡打挂
    if (scores.value.length === 0) {
      if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
      else if (!(e instanceof ApiError)) errorMsg.value = '打分记录加载失败，请稍后重试';
    }
  } finally {
    loading.value = false;
    if (hasPending.value) startPoll();
    else stopPoll();
  }
}

/** 手动重打：不指定 requestId，走「最新投递解析得到就打匹配分，否则通用分析」的自动口径 */
async function rescore(): Promise<void> {
  if (rescoring.value) return;
  rescoring.value = true;
  try {
    await rescoreCandidate(props.candidateId);
    toast.success('已提交打分任务，完成后自动刷新');
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '提交打分任务失败，请稍后重试');
  } finally {
    rescoring.value = false;
  }
}

/** 分数着色口径（与候选人列表「匹配度」列一致）：≥75 绿 / 60-74 橙 / <60 红 */
function scoreTextColor(score: number): string {
  if (score >= 75) return 'text-[#12A150]';
  if (score >= 60) return 'text-[#B8730E]';
  return 'text-[#D83931]';
}

function scoreBarColor(score: number): string {
  if (score >= 75) return 'bg-[#12A150]';
  if (score >= 60) return 'bg-[#B8730E]';
  return 'bg-[#D83931]';
}

function recommendationChipClass(rec: string | null): string {
  return cn(
    'rounded px-2 py-0.5 text-[11.5px] font-medium',
    rec === 'recommend' ? 'bg-[#EAF6EF] text-[#12A150]'
      : rec === 'not_recommend' ? 'bg-[#FDECEB] text-[#D83931]'
        : 'bg-[#F3F4F6] text-t2',
  );
}

onMounted(() => {
  void load();
});

onBeforeUnmount(stopPoll);
</script>

<template>
  <div>
    <div class="mb-2 flex items-center gap-2">
      <span class="text-[13px] font-semibold text-t1">LLM 打分</span>
      <span class="text-[12px] text-t4">采集落库后自动触发，对最新简历版本打分</span>
      <div class="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          class="h-[26px] rounded-md border border-line px-2.5 text-[12px] text-t2 transition hover:bg-hover"
          :disabled="loading"
          @click="load"
        >
          刷新
        </button>
        <button
          class="h-[26px] rounded-md border border-line px-2.5 text-[12px] text-t2 transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="rescoring"
          @click="rescore"
        >
          {{ rescoring ? '提交中…' : '重新打分' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="rounded-lg border border-line px-4 py-6 text-center text-[12.5px] text-t4">
      加载中…
    </div>
    <div v-else-if="errorMsg" class="rounded-lg border border-line px-4 py-6 text-center text-[12.5px] text-danger">
      {{ errorMsg }}
    </div>
    <div
      v-else-if="scores.length === 0"
      class="rounded-lg border border-line px-4 py-6 text-center text-[12.5px] text-t4"
    >
      暂无打分记录。采集新简历后会自动触发；也可点右上角「重新打分」对最新简历版本手动发起。
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="s in scores"
        :key="s.id"
        class="rounded-lg border border-line px-4 py-3"
      >
        <!-- 行头：类型 / 参照需求单 / 总分与结论 -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded bg-[#EEF1FF] px-2 py-0.5 text-[11.5px] font-medium text-[#4F46E5]">
            {{ SCORE_TYPE_LABELS[s.scoreType] ?? s.scoreType }}
          </span>
          <span v-if="s.requestTitle" class="min-w-0 truncate text-[12.5px] text-t3" :title="s.requestTitle">
            {{ s.requestTitle }}
          </span>
          <span v-if="s.status === 'pending'" class="ml-auto text-[12px] text-t4">打分中…</span>
          <template v-else-if="s.status === 'success'">
            <span v-if="s.recommendation" :class="recommendationChipClass(s.recommendation)">
              {{ RECOMMENDATION_LABELS[s.recommendation] ?? s.recommendation }}
            </span>
            <span class="ml-auto text-[22px] font-semibold leading-none" :class="scoreTextColor(s.score ?? 0)">
              {{ s.score }}
            </span>
          </template>
        </div>

        <!-- 打分中 -->
        <div v-if="s.status === 'pending'" class="mt-1.5 text-[12px] text-t4">
          LLM 正在分析最新简历版本，通常需要几秒到几十秒，完成后自动刷新。
        </div>

        <!-- 失败：给出原因，重打入口在卡片右上角（全局重打，不必逐行放按钮） -->
        <div
          v-else-if="s.status === 'failed'"
          class="mt-2 rounded border border-[#F5C2BD] bg-[#FDECEB] px-3 py-2 text-[12px] text-[#D83931]"
        >
          打分失败：{{ s.failReason ?? '未回报原因' }}
        </div>

        <!-- 成功：总评 + 维度条 + 亮点/风险 -->
        <template v-else>
          <div v-if="s.summary" class="mt-2 text-[12.5px] leading-relaxed text-t2">{{ s.summary }}</div>

          <div v-if="s.dimensions.length > 0" class="mt-3 space-y-2">
            <div v-for="d in s.dimensions" :key="d.name">
              <div class="flex items-center gap-3 text-[12px]">
                <span class="w-[76px] shrink-0 truncate text-t3" :title="d.name">{{ d.name }}</span>
                <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#F3F4F6]">
                  <div
                    class="h-full rounded-full"
                    :class="scoreBarColor(d.score ?? 0)"
                    :style="{ width: `${d.score ?? 0}%` }"
                  />
                </div>
                <span class="w-7 shrink-0 text-right font-medium text-t2">{{ d.score ?? '—' }}</span>
              </div>
              <div v-if="d.comment" class="mt-0.5 pl-[88px] text-[11.5px] leading-relaxed text-t4">{{ d.comment }}</div>
            </div>
          </div>

          <div v-if="s.highlights.length > 0 || s.risks.length > 0" class="mt-3 grid grid-cols-2 gap-x-5">
            <div v-if="s.highlights.length > 0">
              <div class="mb-1 text-[12px] font-medium text-[#12A150]">亮点</div>
              <ul class="list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-t2">
                <li v-for="(h, i) in s.highlights" :key="`h-${i}`">{{ h }}</li>
              </ul>
            </div>
            <div v-if="s.risks.length > 0">
              <div class="mb-1 text-[12px] font-medium text-[#D83931]">风险</div>
              <ul class="list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-t2">
                <li v-for="(r, i) in s.risks" :key="`r-${i}`">{{ r }}</li>
              </ul>
            </div>
          </div>
        </template>

        <div class="mt-2 text-[11px] text-t4">
          模型 {{ s.model ?? '—' }} · {{ s.updatedAt ? formatUtcIso(s.updatedAt) : '—' }}
        </div>
      </div>
    </div>
  </div>
</template>
