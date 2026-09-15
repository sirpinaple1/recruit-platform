<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { fetchMe } from '@/lib/api/auth.api';
import { ApiError } from '@/lib/httpClient';
import { useAuthStore } from '@/stores/auth';
import type { LoginVO } from '@/types/auth.types';

/**
 * 工作台占位页（T5 起逐步替换为真实业务模块）。
 * 挂载即调 /api/auth/me：既校验 token 有效性，也刷新用户信息。
 */

const router = useRouter();
const authStore = useAuthStore();

const me = ref<LoginVO | null>(authStore.user.value);
const loading = ref(true);
const errorMsg = ref('');

onMounted(async () => {
  try {
    const vo = await fetchMe();
    authStore.setUser(vo);
    me.value = vo;
  } catch (e) {
    // token 失效（401）时 httpClient 已统一清态并跳登录，这里只兜底展示其余错误
    if (e instanceof ApiError && e.code !== 401) {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
});

function onLogout(): void {
  authStore.logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-6">
    <div class="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
      <h1 class="text-xl font-semibold text-gray-900">Tritree 招聘工作台</h1>
      <p class="mt-2 text-sm text-gray-500">工作台建设中，业务模块将按任务分解逐步落地</p>
      <router-link
        to="/hr-requests"
        class="mt-6 inline-flex h-9 items-center justify-center rounded-lg bg-[#2D5BE3] px-4 text-sm font-medium text-white transition hover:brightness-110"
      >
        进入需求单管理
      </router-link>

      <div v-if="loading" class="mt-8 text-sm text-gray-400">正在校验登录态…</div>
      <div v-else-if="errorMsg" class="mt-8 text-sm text-red-600">{{ errorMsg }}</div>
      <dl v-else-if="me" class="mt-8 space-y-3 text-sm">
        <div class="flex justify-between">
          <dt class="text-gray-500">姓名</dt>
          <dd class="font-medium text-gray-900">{{ me.realName }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-gray-500">账号</dt>
          <dd class="font-medium text-gray-900">{{ me.username }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-gray-500">角色</dt>
          <dd class="font-medium text-gray-900">{{ me.role }}</dd>
        </div>
      </dl>

      <button
        class="mt-8 w-full rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 transition hover:border-blue-600 hover:text-blue-600"
        @click="onLogout"
      >
        退出登录
      </button>
    </div>
  </div>
</template>
