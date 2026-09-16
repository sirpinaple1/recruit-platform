<script setup lang="ts">
import { onMounted, ref } from 'vue';

import AppShell from '@/components/layout/AppShell.vue';
import {
  createExtensionToken,
  fetchExtensionTokenList,
  revokeExtensionToken,
} from '@/lib/api/extension-token.api';
import { ApiError } from '@/lib/httpClient';
import { formatUtcIso } from '@/lib/utils';
import {
  EXTENSION_TOKEN_STATUS_LABELS,
  type ExtensionTokenStatus,
  type ExtensionTokenVO,
} from '@/types/extension-token.types';

/**
 * 扩展授权管理页：为浏览器扩展签发访问令牌。
 * 明文 token 仅创建时一次性展示（红线 §5.5：不落库不落日志），之后只可查看 hash 前缀。
 */

const STATUS_CHIP_CLASS: Record<ExtensionTokenStatus, string> = {
  active: 'bg-[#EAF6EF] text-[#12A150]',
  revoked: 'bg-[#F3F4F6] text-t2',
};

const tokens = ref<ExtensionTokenVO[]>([]);
const loading = ref(false);
const errorMsg = ref('');

// 生成弹窗：表单态（填名称）→ 成功态（一次性明文）
const createVisible = ref(false);
const createName = ref('');
const creating = ref(false);
const createErrorMsg = ref('');
const createdToken = ref('');
const copied = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = '';
  try {
    tokens.value = await fetchExtensionTokenList();
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  createVisible.value = true;
  createName.value = '';
  creating.value = false;
  createErrorMsg.value = '';
  createdToken.value = '';
  copied.value = false;
}

async function submitCreate(): Promise<void> {
  const name = createName.value.trim();
  if (name === '' || creating.value) return;
  creating.value = true;
  createErrorMsg.value = '';
  try {
    const vo = await createExtensionToken(name);
    createdToken.value = vo.token;
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) createErrorMsg.value = e.message;
    else if (!(e instanceof ApiError)) createErrorMsg.value = '生成失败，请稍后重试';
  } finally {
    creating.value = false;
  }
}

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(createdToken.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // 剪贴板不可用时保持未复制态，token 区已 select-all 可手动复制
  }
}

function closeCreate(): void {
  createVisible.value = false;
  void load();
}

async function onRevoke(row: ExtensionTokenVO): Promise<void> {
  if (row.status !== 'active') return;
  if (!window.confirm(`确认吊销「${row.name}」？吊销后使用该授权的扩展将立即失效。`)) return;
  try {
    await revokeExtensionToken(row.id);
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.code !== 401) errorMsg.value = e.message;
    else if (!(e instanceof ApiError)) errorMsg.value = '吊销失败，请稍后重试';
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <AppShell title="扩展授权">
    <!-- 工具栏 -->
    <div class="flex items-center gap-3">
      <div class="text-xs text-t4">
        为浏览器扩展签发访问授权：明文 token 仅生成时展示一次，请立即粘贴到扩展配置页「后端令牌」
      </div>
      <button
        class="ml-auto flex h-[34px] items-center gap-1.5 rounded-md bg-primary px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110"
        @click="openCreate"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <g stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round">
            <path d="M8 3.4v9.2M3.4 8h9.2" />
          </g>
        </svg>
        生成授权
      </button>
    </div>

    <!-- 表格卡片 -->
    <div class="overflow-hidden rounded-lg border border-line bg-white">
      <div class="grid grid-cols-[1.3fr_150px_90px_120px_120px_120px_64px] items-center border-b border-divider bg-[#FAFBFC] px-5 py-2.5 text-[11.5px] font-medium text-t3">
        <div>名称</div>
        <div>token 前缀</div>
        <div>状态</div>
        <div>创建人</div>
        <div>最近使用</div>
        <div>创建时间</div>
        <div>操作</div>
      </div>

      <div v-if="loading" class="px-5 py-12 text-center text-sm text-t4">加载中…</div>
      <div v-else-if="errorMsg" class="px-5 py-12 text-center text-sm text-danger">{{ errorMsg }}</div>
      <div v-else-if="tokens.length === 0" class="px-5 py-12 text-center text-sm text-t4">
        暂无授权，点击右上角「生成授权」为浏览器扩展签发令牌
      </div>

      <div
        v-for="row in tokens"
        :key="row.id"
        class="grid min-h-16 grid-cols-[1.3fr_150px_90px_120px_120px_120px_64px] items-center gap-5 border-b border-divider px-5 text-[13px] text-t2 transition last:border-b-0 hover:bg-[#FAFBFC]"
      >
        <div class="min-w-0">
          <div class="truncate text-[13px] font-semibold text-t1">{{ row.name }}</div>
        </div>
        <div class="min-w-0 truncate font-mono text-[11.5px] text-t3">{{ row.tokenHashPrefix ?? '—' }}</div>
        <div>
          <span class="rounded px-2 py-0.5 text-[11.5px] font-medium" :class="STATUS_CHIP_CLASS[row.status]">
            {{ EXTENSION_TOKEN_STATUS_LABELS[row.status] }}
          </span>
        </div>
        <div class="min-w-0 truncate text-[12.5px] text-t3">{{ row.userName ?? '—' }}</div>
        <div class="text-[12.5px] text-t3">
          <template v-if="row.lastUsedAt">{{ formatUtcIso(row.lastUsedAt) }}</template>
          <template v-else>从未使用</template>
        </div>
        <div class="text-[12.5px] text-t3">
          <template v-if="row.createdAt">{{ formatUtcIso(row.createdAt) }}</template>
          <template v-else>—</template>
        </div>
        <div>
          <button
            v-if="row.status === 'active'"
            class="text-[12.5px] font-medium text-danger transition hover:opacity-70"
            @click="onRevoke(row)"
          >
            吊销
          </button>
          <span v-else class="text-[12.5px] text-t4">—</span>
        </div>
      </div>

      <!-- 底部统计 -->
      <div class="flex h-[52px] items-center justify-between border-t border-divider px-5">
        <span class="text-xs text-t3">共 {{ tokens.length }} 个授权</span>
        <span class="text-[11.5px] text-t4">扩展使用授权访问待发布草稿，并回填发布结果</span>
      </div>
    </div>

    <!-- 生成授权弹窗 -->
    <div
      v-if="createVisible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      @click.self="closeCreate"
    >
      <div class="w-[440px] rounded-lg bg-white p-5 shadow-xl">
        <!-- 表单态 -->
        <template v-if="createdToken === ''">
          <div class="text-[15px] font-semibold text-t1">生成扩展授权</div>
          <div class="mt-1 text-xs leading-relaxed text-t4">
            授权用于浏览器扩展访问后端的草稿拉取与结果回填接口，命名便于区分使用者。
          </div>
          <input
            v-model="createName"
            class="mt-3 h-[36px] w-full rounded-md border border-line px-3 text-[13px] text-t1 outline-none placeholder:text-t4 focus:border-primary"
            placeholder="如：张三的工作电脑"
            maxlength="64"
            @keyup.enter="submitCreate"
          />
          <div v-if="createErrorMsg" class="mt-2 text-xs text-danger">{{ createErrorMsg }}</div>
          <div class="mt-4 flex justify-end gap-2">
            <button
              class="h-[34px] rounded-md border border-line bg-white px-3.5 text-[12.5px] text-t2 transition hover:bg-hover"
              @click="closeCreate"
            >
              取消
            </button>
            <button
              class="h-[34px] rounded-md bg-primary px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="creating || createName.trim() === ''"
              @click="submitCreate"
            >
              {{ creating ? '生成中…' : '生成' }}
            </button>
          </div>
        </template>

        <!-- 成功态：明文 token 一次性展示 -->
        <template v-else>
          <div class="text-[15px] font-semibold text-t1">授权已生成</div>
          <div class="mt-3 rounded-md bg-[#FEF6E7] px-3 py-2 text-xs leading-relaxed text-[#D97706]">
            明文 token 仅展示这一次，关闭后无法找回。请立即复制并粘贴到扩展配置页「后端令牌」。
          </div>
          <div class="mt-3 select-all break-all rounded-md border border-line bg-page px-3 py-2.5 font-mono text-[12px] leading-relaxed text-t1">
            {{ createdToken }}
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <button
              class="h-[34px] rounded-md border border-line bg-white px-3.5 text-[12.5px] text-t2 transition hover:bg-hover"
              @click="copyToken"
            >
              {{ copied ? '已复制' : '复制 token' }}
            </button>
            <button
              class="h-[34px] rounded-md bg-primary px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110"
              @click="closeCreate"
            >
              我已保存，关闭
            </button>
          </div>
        </template>
      </div>
    </div>
  </AppShell>
</template>
