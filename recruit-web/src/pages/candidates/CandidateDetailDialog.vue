<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { fetchAttachmentBlob, fetchCandidateDetail } from '@/lib/api/candidate.api';
import { ApiError } from '@/lib/httpClient';
import { cn, formatUtcIso } from '@/lib/utils';
import ResumeScoreCard from '@/pages/candidates/ResumeScoreCard.vue';
import {
  ATTACHMENT_STATUS_LABELS,
  AUDIT_ACTION_LABELS,
  GENDER_LABELS,
  SCENE_LABELS,
  SOURCE_CHANNEL_LABELS,
  type AttachmentVO,
  type CollectAuditVO,
  type ResumeVersionVO,
} from '@/types/candidate.types';

/**
 * 候选人详情：候选人 + 简历版本 + 附件 + 采集审计。
 *
 * 审计区是这一页的重点 —— 框架 §3 要求「每一次采集动作都能从授权基础、审计记录、
 * 留存策略三方面给出完整解释」，所以 pageUrl / 操作人 / 动作时刻必须直接可见，
 * 而不是藏在次级入口里。
 */

const props = defineProps<{ candidateId: string }>();
const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const errorMsg = ref('');
const detail = ref<Awaited<ReturnType<typeof fetchCandidateDetail>> | null>(null);
const expandedVersionIds = ref<string[]>([]);

/**
 * 附件预览。
 *
 * 用 object URL + iframe 就地渲染，而不是 `window.open` 开新标签：
 *   1) 附件正文要带 Bearer 头才能取（后端走登录态），必须先 await 再拿到 blob，
 *      而 await 之后再 `window.open` 会被浏览器的弹窗拦截器拦掉 ——
 *      想绕过就得先开空白窗再塞地址，体验上会闪一个白页；
 *   2) 详情弹窗本来就是审阅场景，就地看比再开一个标签更贴合。
 */
const preview = ref<{ id: string; name: string; url: string } | null>(null);
const previewLoadingId = ref('');
const previewError = ref('');

const candidate = computed(() => detail.value?.candidate ?? null);

function versionChipClass(v: ResumeVersionVO): string {
  return cn(
    'rounded px-2 py-0.5 text-[11.5px] font-medium',
    v.rawEncrypted === 1 ? 'bg-[#FAEEDA] text-[#B8730E]' : 'bg-[#F3F4F6] text-t2',
  );
}

function attachmentChipClass(a: AttachmentVO): string {
  return cn(
    'rounded px-2 py-0.5 text-[11.5px] font-medium',
    a.status === 'stored' ? 'bg-[#EAF6EF] text-[#12A150]'
      : a.status === 'failed' ? 'bg-[#FDECEB] text-[#D83931]' : 'bg-[#F3F4F6] text-t2',
  );
}

function auditChipClass(a: CollectAuditVO): string {
  return cn(
    'rounded px-2 py-0.5 text-[11.5px] font-medium',
    a.result === 'ok' ? 'bg-[#EAF6EF] text-[#12A150]'
      : a.result === 'failed' ? 'bg-[#FDECEB] text-[#D83931]' : 'bg-[#F3F4F6] text-t2',
  );
}

/** fieldsJson 是后端归一后的 JSON 字符串；解析失败不抛错，按空展示 */
function parseFields(json: string | null): [string, string][] {
  if (!json) return [];
  try {
    const obj: unknown = JSON.parse(json);
    if (typeof obj !== 'object' || obj === null) return [];
    return Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
      let text: string;
      if (v === null || v === undefined) text = '—';
      else if (typeof v === 'object') text = JSON.stringify(v);
      else text = String(v);
      return [k, text.length > 160 ? `${text.slice(0, 160)}…` : text];
    });
  } catch {
    return [];
  }
}

function toggleVersion(id: string): void {
  const i = expandedVersionIds.value.indexOf(id);
  if (i >= 0) expandedVersionIds.value.splice(i, 1);
  else expandedVersionIds.value.push(id);
}

function humanBytes(n: number | null): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

/** 附件展示名：file_name 为空时退到 platformFileId（与后端 filenameOf 同口径） */
function attachmentName(a: AttachmentVO): string {
  return a.fileName ?? a.platformFileId;
}

/** 释放 object URL —— 必须成对出现，否则每预览一份就漏一份 PDF 的内存 */
function revokePreview(): void {
  if (preview.value) {
    URL.revokeObjectURL(preview.value.url);
    preview.value = null;
  }
}

function closePreview(): void {
  revokePreview();
  previewError.value = '';
}

/** 同一个附件再点一次 = 收起；换一个 = 先释放旧的再取新的 */
async function openPreview(a: AttachmentVO): Promise<void> {
  if (preview.value?.id === a.id) {
    closePreview();
    return;
  }
  revokePreview();
  previewError.value = '';
  previewLoadingId.value = a.id;
  try {
    const blob = await fetchAttachmentBlob(a.id);
    // 期间用户可能已经点了别的附件或关掉了面板 —— 那就不要把这次结果画上去
    if (previewLoadingId.value !== a.id) {
      return;
    }
    preview.value = { id: a.id, name: attachmentName(a), url: URL.createObjectURL(blob) };
  } catch (e) {
    previewError.value = e instanceof ApiError ? e.message : '附件打开失败，请稍后重试';
  } finally {
    if (previewLoadingId.value === a.id) previewLoadingId.value = '';
  }
}

/**
 * 浏览器另存。
 *
 * 为什么用 fetch 后的 Blob 触发下载、而不是给 `<a href>` 指后端地址：
 * 该接口要 Bearer 头，裸链接取不到（会 401）。这里把 Blob 转成 object URL 后
 * 造一个带 `download` 属性的临时 `<a>` 点一下即可，纯前端动作、不弹窗拦截。
 */
async function downloadAttachment(a: AttachmentVO): Promise<void> {
  previewError.value = '';
  try {
    const blob = await fetchAttachmentBlob(a.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = attachmentName(a);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    previewError.value = e instanceof ApiError ? e.message : '附件下载失败，请稍后重试';
  }
}

onMounted(async () => {
  try {
    detail.value = await fetchCandidateDetail(props.candidateId);
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  revokePreview();
});
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6" @click.self="emit('close')">
    <div class="flex max-h-[86vh] w-full max-w-[880px] flex-col overflow-hidden rounded-lg bg-white">
      <!-- 头部 -->
      <div class="flex items-center gap-3 border-b border-divider px-5 py-3.5">
        <div class="min-w-0">
          <div class="truncate text-[15px] font-semibold text-t1">
            {{ candidate?.name ?? '候选人详情' }}
          </div>
          <div class="mt-0.5 truncate font-mono text-[11.5px] text-t4">
            {{ candidate?.platform ?? '' }} / {{ candidate?.platformUserId ?? '' }}
            <!-- 归一是否生效肉眼可验：两种 ID 形态都在，就不必去翻库确认 -->
            <template v-if="candidate?.platformUserIdAlt">
              <span class="text-t4"> （另一形态 {{ candidate.platformUserIdAlt }}）</span>
            </template>
          </div>
        </div>
        <span
          v-if="candidate"
          class="rounded px-2 py-0.5 text-[11.5px] font-medium"
          :class="candidate.sourceChannel === 'recommend' ? 'bg-[#EEF1FF] text-[#4F46E5]' : 'bg-[#EAF6EF] text-[#12A150]'"
        >
          {{ SOURCE_CHANNEL_LABELS[candidate.sourceChannel ?? ''] ?? '—' }}
        </span>
        <button
          class="ml-auto h-[28px] rounded-md border border-line px-3 text-[12.5px] text-t2 transition hover:bg-hover"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div v-if="loading" class="py-12 text-center text-sm text-t4">加载中…</div>
        <div v-else-if="errorMsg" class="py-12 text-center text-sm text-danger">{{ errorMsg }}</div>

        <template v-else-if="detail && candidate">
          <!-- 基本信息 -->
          <div class="mb-4 grid grid-cols-4 gap-x-5 gap-y-2 rounded-lg border border-line bg-[#FAFBFC] px-4 py-3 text-[12.5px]">
            <div><span class="text-t4">性别</span> <span class="ml-1 text-t1">{{ candidate.gender ? GENDER_LABELS[candidate.gender] ?? '—' : '—' }}</span></div>
            <div><span class="text-t4">年龄</span> <span class="ml-1 text-t1">{{ candidate.age ?? '—' }}</span></div>
            <div><span class="text-t4">城市</span> <span class="ml-1 text-t1">{{ candidate.city ?? '—' }}</span></div>
            <div><span class="text-t4">工作年限</span> <span class="ml-1 text-t1">{{ candidate.workYear ?? '—' }}</span></div>
            <div><span class="text-t4">学历</span> <span class="ml-1 text-t1">{{ candidate.education ?? '—' }}</span></div>
            <div class="col-span-2"><span class="text-t4">院校 / 专业</span> <span class="ml-1 text-t1">{{ candidate.school ?? '—' }}<template v-if="candidate.major"> · {{ candidate.major }}</template></span></div>
            <div><span class="text-t4">期望职位</span> <span class="ml-1 text-t1">{{ candidate.currentTitle ?? '—' }}</span></div>
            <div><span class="text-t4">期望薪资</span> <span class="ml-1 text-t1">{{ candidate.expectSalary ?? '—' }}</span></div>
            <div><span class="text-t4">首次采集</span> <span class="ml-1 text-t1">{{ candidate.firstCollectedAt ? formatUtcIso(candidate.firstCollectedAt) : '—' }}</span></div>
            <div><span class="text-t4">最近采集</span> <span class="ml-1 text-t1">{{ candidate.lastCollectedAt ? formatUtcIso(candidate.lastCollectedAt) : '—' }}</span></div>
            <div class="col-span-2">
              <span class="text-t4">归并状态</span>
              <span class="ml-1 text-t1">{{ candidate.mergedIntoId ? `已并入 ${candidate.mergedIntoId}` : '独立记录' }}</span>
            </div>
          </div>

          <!-- 投递职位（人 × 平台岗位） -->
          <div class="mb-2 flex items-center gap-2">
            <span class="text-[13px] font-semibold text-t1">投递职位</span>
            <span class="text-[12px] text-t4">
              {{ detail.applications.length }} 条（来自采集响应中的平台岗位）
            </span>
          </div>
          <div class="mb-4 overflow-hidden rounded-lg border border-line">
            <div v-if="detail.applications.length === 0" class="px-4 py-6 text-center text-[12.5px] text-t4">
              无岗位线索。说明该候选人不是投递来的（如推荐列表场景我方主动触达），
              或采集时平台响应里没有岗位信息 —— 而不是系统漏记。
            </div>
            <div
              v-for="a in detail.applications"
              :key="a.id"
              class="flex items-center gap-4 border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-t1">
                  <template v-if="a.requestTitle">{{ a.requestTitle }}</template>
                  <template v-else><span class="text-warning">未归类</span></template>
                </div>
                <div class="mt-0.5 truncate text-[11.5px] text-t4" :title="a.platformJobHint ?? ''">
                  平台岗位 {{ a.platformJobId }}
                  <template v-if="a.requestNo"> · {{ a.requestNo }}</template>
                  <template v-if="a.platformJobHint"> · {{ a.platformJobHint }}</template>
                </div>
              </div>
              <div class="shrink-0 text-[11.5px] text-t4">
                {{ a.appliedAt ? formatUtcIso(a.appliedAt) : '—' }}
              </div>
            </div>
          </div>

          <!-- LLM 打分（采集落库后异步触发；独立组件见 ResumeScoreCard.vue） -->
          <ResumeScoreCard :candidate-id="candidateId" class="mb-4" />

          <!-- 简历版本 -->
          <div class="mb-2 flex items-center gap-2">
            <span class="text-[13px] font-semibold text-t1">简历版本</span>
            <span class="text-[12px] text-t4">{{ detail.versions.length }} 份（内容相同会被去重跳过）</span>
          </div>
          <div class="mb-4 overflow-hidden rounded-lg border border-line">
            <div v-if="detail.versions.length === 0" class="px-4 py-6 text-center text-[12.5px] text-t4">无</div>
            <template v-for="v in detail.versions" :key="v.id">
              <div
                class="flex cursor-pointer items-center gap-3 border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0 hover:bg-[#FAFBFC]"
                @click="toggleVersion(v.id)"
              >
                <span :class="versionChipClass(v)">
                  {{ SCENE_LABELS[v.source] ?? v.source }}
                </span>
                <span class="text-t3">{{ v.collectedAt ? formatUtcIso(v.collectedAt) : '—' }}</span>
                <span class="text-t3">字段 {{ v.fieldCount ?? 0 }} 个</span>
                <span v-if="v.rawEncrypted === 1" class="text-[#B8730E]">密文原文（未解密）</span>
                <span v-if="v.rawTruncated === 1" class="text-[#B8730E]">快照被截断</span>
                <span class="ml-auto text-t4">{{ v.operatorName ?? '—' }}</span>
              </div>
              <div v-if="expandedVersionIds.includes(v.id)" class="border-b border-divider bg-[#FAFBFC] px-4 py-3 last:border-b-0">
                <div v-if="v.sourceApi" class="mb-2 truncate font-mono text-[11.5px] text-t4">{{ v.sourceApi }}</div>
                <div v-if="parseFields(v.fieldsJson).length === 0" class="text-[12.5px] text-t4">无归一字段</div>
                <div v-else class="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[12px]">
                  <div v-for="pair in parseFields(v.fieldsJson)" :key="pair[0]" class="min-w-0">
                    <span class="font-mono text-t4">{{ pair[0] }}</span>
                    <span class="ml-1.5 text-t1">{{ pair[1] }}</span>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- 附件 -->
          <div class="mb-2 flex items-center gap-2">
            <span class="text-[13px] font-semibold text-t1">附件</span>
            <span class="text-[12px] text-t4">
              {{ detail.attachments.length }} 个（平台生成的 PDF，由扩展重放下载后入库）
            </span>
          </div>
          <div class="mb-4 overflow-hidden rounded-lg border border-line">
            <div v-if="detail.attachments.length === 0" class="px-4 py-6 text-center text-[12.5px] text-t4">无</div>
            <div
              v-for="a in detail.attachments"
              :key="a.id"
              class="flex items-center gap-3 border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0"
            >
              <span :class="attachmentChipClass(a)">{{ ATTACHMENT_STATUS_LABELS[a.status] ?? a.status }}</span>
              <span class="min-w-0 flex-1 truncate text-t1" :title="attachmentName(a)">{{ attachmentName(a) }}</span>
              <span class="text-t3">{{ humanBytes(a.bytes) }}</span>
              <span class="font-mono text-[11px] text-t4">{{ a.sha256 ? a.sha256.slice(0, 12) : '—' }}</span>
              <span class="text-t4">{{ a.storedAt ? formatUtcIso(a.storedAt) : '—' }}</span>
              <!-- 只有在「已落盘 + 文件确实在盘上」时才给按钮：后端算的 openable，
                   避免点了才知道打不开 -->
              <div v-if="a.openable" class="flex shrink-0 items-center gap-1.5">
                <button
                  class="h-[26px] rounded-md border border-line px-2.5 text-[12px] text-t2 transition hover:bg-hover"
                  :class="preview?.id === a.id ? 'border-primary text-primary' : ''"
                  :disabled="previewLoadingId === a.id"
                  @click="openPreview(a)"
                >
                  {{ previewLoadingId === a.id ? '加载中…' : (preview?.id === a.id ? '收起' : '预览') }}
                </button>
                <button
                  class="h-[26px] rounded-md border border-line px-2.5 text-[12px] text-t2 transition hover:bg-hover"
                  @click="downloadAttachment(a)"
                >
                  下载
                </button>
              </div>
              <span v-else-if="a.status === 'stored'" class="shrink-0 text-[11.5px] text-danger">
                文件缺失
              </span>
            </div>
            <div v-if="detail.attachments.some((a) => a.status === 'failed')" class="border-t border-divider bg-[#FDECEB] px-4 py-2 text-[11.5px] text-[#D83931]">
              <div v-for="a in detail.attachments.filter((x) => x.status === 'failed')" :key="`f-${a.id}`">
                下载失败原因（{{ a.platformFileId }}）：{{ a.failReason ?? '未回报' }}
              </div>
            </div>
          </div>

          <!-- 预览失败提示：与名单分开放在盒子外，避免被误读成某一条附件的失败原因 -->
          <div
            v-if="previewError"
            class="mb-4 rounded-lg border border-[#F5C2BD] bg-[#FDECEB] px-4 py-2 text-[11.5px] text-[#D83931]"
          >
            {{ previewError }}
          </div>

          <!-- 附件预览（就地渲染，不新开标签；见 script 里 openPreview 的说明） -->
          <div v-if="preview" class="mb-4 overflow-hidden rounded-lg border border-line">
            <div class="flex items-center gap-2 border-b border-divider bg-[#FAFBFC] px-4 py-2">
              <span class="text-[12.5px] font-medium text-t1">预览</span>
              <span class="min-w-0 flex-1 truncate text-[12px] text-t3" :title="preview.name">{{ preview.name }}</span>
              <button
                class="h-[26px] rounded-md border border-line bg-white px-2.5 text-[12px] text-t2 transition hover:bg-hover"
                @click="closePreview"
              >
                关闭预览
              </button>
            </div>
            <iframe
              :src="preview.url"
              class="h-[520px] w-full border-0 bg-white"
              title="附件预览"
            />
          </div>

          <!-- 采集审计 -->
          <div class="mb-2 flex items-center gap-2">
            <span class="text-[13px] font-semibold text-t1">采集审计</span>
            <span class="text-[12px] text-t4">who / when / what / 来源 URL，append-only</span>
          </div>
          <div class="overflow-hidden rounded-lg border border-line">
            <div v-if="detail.audits.length === 0" class="px-4 py-6 text-center text-[12.5px] text-t4">无</div>
            <div
              v-for="a in detail.audits"
              :key="a.id"
              class="border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0"
            >
              <div class="flex items-center gap-3">
                <span :class="auditChipClass(a)">{{ AUDIT_ACTION_LABELS[a.action] ?? a.action }}</span>
                <!-- 归并前的审计行仍挂在被兼并的那条记录上（审计 append-only，归并脚本刻意不改）。
                     标出来是为了让「为什么这条的 candidateId 不是当前人」当场可解释，
                     而不是让人怀疑数据串了。 -->
                <span
                  v-if="candidate && a.candidateId !== candidate.id"
                  class="rounded px-1.5 py-0.5 text-[11px] font-medium bg-[#F3F4F6] text-t3"
                  title="归并前采集于同一人的另一条记录，已并入当前候选人"
                >
                  归并前
                </span>
                <span class="text-t3">{{ a.occurredAt ? formatUtcIso(a.occurredAt) : '—' }}</span>
                <span class="text-t3">{{ a.operatorName ?? '—' }}</span>
                <span v-if="a.clientNote" class="min-w-0 flex-1 truncate text-t4" :title="a.clientNote">{{ a.clientNote }}</span>
              </div>
              <div v-if="a.pageUrl" class="mt-1 truncate font-mono text-[11px] text-t4" :title="a.pageUrl">
                {{ a.pageUrl }}
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
