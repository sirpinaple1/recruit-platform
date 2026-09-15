<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { useCharacterStage } from '@/composables/useCharacterStage';
import { login as loginApi } from '@/lib/api/auth.api';
import { ApiError } from '@/lib/httpClient';
import { useAuthStore } from '@/stores/auth';

import './login.css';

/**
 * 登录页 —— 结构与交互移植自设计稿原型《登录页 v3》。
 * 双角色：应聘者（官网入口，暂未接后端）/ 员工（对接 POST /api/auth/login）。
 */

type Role = 'candidate' | 'employee';

interface RoleConfig {
  domain: string;
  switchTo: string;
  title: string;
  sub: string;
  wordmark: string;
  accountLabel: string;
  accountPlaceholder: string;
  showPrefix: boolean;
  social: string;
  remember: string;
  footA: string;
  footB: string;
}

const ROLES: Record<Role, RoleConfig> = {
  candidate: {
    domain: '招聘官网 · 应聘者入口',
    switchTo: '员工登录 →',
    title: '欢迎回来',
    sub: '请输入账号信息，登录后查看投递进度与面试安排',
    wordmark: 'Tritree 招聘',
    accountLabel: '手机号',
    accountPlaceholder: '请输入手机号',
    showPrefix: true,
    social: '使用微信登录',
    remember: '30 天内自动登录',
    footA: '还没有账号？',
    footB: '立即注册',
  },
  employee: {
    domain: '内部系统 · 员工入口',
    switchTo: '你是应聘者？前往招聘官网 →',
    title: '员工登录',
    sub: '使用企业账号进入招聘工作台，与应聘者账号体系相互独立',
    wordmark: 'Tritree 招聘工作台',
    accountLabel: '企业账号',
    accountPlaceholder: '用户名 / 工号',
    showPrefix: false,
    social: '使用钉钉扫码登录',
    remember: '7 天内自动登录',
    footA: '还没有企业账号？',
    footB: '联系 HR 管理员开通',
  },
};

const router = useRouter();
const authStore = useAuthStore();

/* ---------- 表单状态 ---------- */
const role = ref<Role>('candidate');
const switching = ref(false);
const account = ref('');
const password = ref('');
const remember = ref(true);
const showPassword = ref(false);
const loading = ref(false);
const done = ref(false);
const errorField = ref<'account' | 'password' | null>(null);
const alertState = ref<{ kind: 'error' | 'ok'; text: string } | null>(null);

const accountInput = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);

const cfg = computed<RoleConfig>(() => ROLES[role.value]);
const passwordLength = computed(() => password.value.length);

/* ---------- 几何角色动画引擎 ---------- */
const stageRef = ref<HTMLElement | null>(null);
const charPurpleRef = ref<HTMLElement | null>(null);
const charBlackRef = ref<HTMLElement | null>(null);
const charOrangeRef = ref<HTMLElement | null>(null);
const charYellowRef = ref<HTMLElement | null>(null);
const eyesPurpleRef = ref<HTMLElement | null>(null);
const eyesBlackRef = ref<HTMLElement | null>(null);
const eyesOrangeRef = ref<HTMLElement | null>(null);
const eyesYellowRef = ref<HTMLElement | null>(null);
const mouthYellowRef = ref<HTMLElement | null>(null);
const isTyping = ref(false);

const engine = useCharacterStage(
  {
    stage: stageRef,
    charPurple: charPurpleRef,
    charBlack: charBlackRef,
    charOrange: charOrangeRef,
    charYellow: charYellowRef,
    eyesPurple: eyesPurpleRef,
    eyesBlack: eyesBlackRef,
    eyesOrange: eyesOrangeRef,
    eyesYellow: eyesYellowRef,
    mouthYellow: mouthYellowRef,
  },
  { isTyping, passwordLength, showPassword },
);

onMounted(() => engine.init());
onBeforeUnmount(() => engine.destroy());

// 密码长度 / 明文切换 → 重新渲染姿态并重排偷瞄（对应原型 syncState）
watch([passwordLength, showPassword], () => {
  engine.renderStage();
  engine.schedulePeek();
});

/* ---------- 交互 ---------- */
function switchRole(): void {
  switching.value = true;
  setTimeout(() => {
    role.value = role.value === 'candidate' ? 'employee' : 'candidate';
    switching.value = false;
    clearAlert();
    resetButton();
  }, 180);
}

function onAccountFocus(): void {
  isTyping.value = true;
  engine.lookAtEachOther();
}

function onAccountBlur(): void {
  isTyping.value = false;
  engine.cancelLookTogether();
  engine.renderStage();
}

function togglePassword(): void {
  showPassword.value = !showPassword.value;
}

/* ---------- 提示与按钮 ---------- */
function showAlert(kind: 'error' | 'ok', text: string, field?: 'account' | 'password'): void {
  alertState.value = { kind, text };
  errorField.value = field ?? null;
}

function clearAlert(): void {
  alertState.value = null;
  errorField.value = null;
}

function resetButton(): void {
  loading.value = false;
  done.value = false;
}

/* ---------- 提交 ---------- */
function validate(): { msg: string; field: 'account' | 'password' } | null {
  const acc = account.value.trim();
  const pwd = password.value;
  if (!acc) {
    return { msg: role.value === 'candidate' ? '请输入手机号' : '请输入用户名', field: 'account' };
  }
  if (role.value === 'candidate' && !/^1[3-9]\d{9}$/.test(acc)) {
    return { msg: '请输入正确的 11 位手机号', field: 'account' };
  }
  if (pwd.length < 6) {
    return { msg: '密码至少 6 位', field: 'password' };
  }
  return null;
}

async function onSubmit(): Promise<void> {
  clearAlert();

  const err = validate();
  if (err) {
    showAlert('error', err.msg, err.field);
    (err.field === 'account' ? accountInput : passwordInput).value?.focus();
    return;
  }

  // 应聘者入口：暂未接后端（后端仅员工账号体系）
  if (role.value === 'candidate') {
    showAlert('ok', '应聘者入口建设中，敬请期待');
    return;
  }

  loading.value = true;
  try {
    const vo = await loginApi({ username: account.value.trim(), password: password.value });
    authStore.login(vo);
    done.value = true;
    showAlert('ok', '登录成功，正在进入招聘工作台…');
    setTimeout(() => {
      void router.push({ name: 'workbench' });
    }, 800);
  } catch (e) {
    showAlert('error', e instanceof ApiError ? e.message : '登录失败，请稍后重试', 'password');
    resetButton();
  }
}
</script>

<template>
  <div class="login-app" :class="{ 'is-employee': role === 'employee' }">
    <!-- 左区 · 品牌插画 -->
    <aside class="brand" :class="{ 'is-employee': role === 'employee' }">
      <div class="brand__bg brand__bg--candidate"></div>
      <div class="brand__bg brand__bg--employee"></div>
      <div class="brand__glow glow-a"></div>
      <div class="brand__glow glow-b"></div>

      <div class="brand__logo">
        <div class="brand__logobox">
          <svg width="20" height="20" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 3 L22 13 H18.5 L24 22 H6 L11.5 13 H8 L15 3 Z" fill="#FFFFFF"/>
            <rect x="13" y="22" width="4" height="5" rx="1" fill="#FFFFFF" opacity="0.65"/>
          </svg>
        </div>
        <span class="brand__wordmark">{{ cfg.wordmark }}</span>
      </div>

      <div class="brand__stagewrap">
        <div class="stage" ref="stageRef">
          <div class="char char--purple" ref="charPurpleRef">
            <div class="char__eyes" ref="eyesPurpleRef">
              <span class="eye"><i></i></span>
              <span class="eye"><i></i></span>
            </div>
          </div>
          <div class="char char--black" ref="charBlackRef">
            <div class="char__eyes" ref="eyesBlackRef">
              <span class="eye"><i></i></span>
              <span class="eye"><i></i></span>
            </div>
          </div>
          <div class="char char--orange" ref="charOrangeRef">
            <div class="char__eyes" ref="eyesOrangeRef">
              <span class="dot"></span>
              <span class="dot"></span>
            </div>
          </div>
          <div class="char char--yellow" ref="charYellowRef">
            <div class="char__eyes" ref="eyesYellowRef">
              <span class="dot"></span>
              <span class="dot"></span>
            </div>
            <div class="char__mouth" ref="mouthYellowRef"></div>
          </div>
        </div>
      </div>

      <div class="brand__legal">
        <a href="#">隐私政策</a>
        <a href="#">服务条款</a>
      </div>
    </aside>

    <!-- 右区 · 登录表单 -->
    <main class="panel">
      <header class="panel__top">
        <span class="panel__domain">{{ cfg.domain }}</span>
        <button class="panel__switch" type="button" @click="switchRole">{{ cfg.switchTo }}</button>
      </header>

      <div class="panel__center">
        <form class="form" :class="{ 'is-switching': switching }" novalidate @submit.prevent="onSubmit">
          <div class="form__head">
            <h1 class="form__title">{{ cfg.title }}</h1>
            <p class="form__sub">{{ cfg.sub }}</p>
          </div>

          <div class="form__body">
            <!-- 账号 -->
            <div class="field">
              <label class="field__label" for="account">{{ cfg.accountLabel }}</label>
              <div class="input" :class="{ 'is-error': errorField === 'account' }">
                <template v-if="cfg.showPrefix">
                  <span class="input__prefix">+86</span>
                  <span class="input__divider"></span>
                </template>
                <input
                  id="account"
                  ref="accountInput"
                  v-model="account"
                  :type="cfg.showPrefix ? 'tel' : 'text'"
                  :placeholder="cfg.accountPlaceholder"
                  autocomplete="username"
                  @focus="onAccountFocus"
                  @blur="onAccountBlur"
                  @input="clearAlert"
                />
              </div>
            </div>

            <!-- 密码 -->
            <div class="field">
              <label class="field__label" for="password">密码</label>
              <div class="input" :class="{ 'is-error': errorField === 'password' }">
                <input
                  id="password"
                  ref="passwordInput"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  placeholder="请输入密码"
                  autocomplete="current-password"
                  @input="clearAlert"
                />
                <button
                  class="input__eye"
                  type="button"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  @mousedown.prevent
                  @click="togglePassword"
                >
                  <svg v-if="!showPassword" width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2 10C2 10 5 4.8 10 4.8S18 10 18 10s-3 5.2-8 5.2S2 10 2 10Z" stroke="#98A2B3" stroke-width="1.4" stroke-linejoin="round"/>
                    <circle cx="10" cy="10" r="2.4" stroke="#98A2B3" stroke-width="1.4"/>
                  </svg>
                  <svg v-else width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2 10C2 10 5 4.8 10 4.8S18 10 18 10s-3 5.2-8 5.2S2 10 2 10Z" stroke="#98A2B3" stroke-width="1.4" stroke-linejoin="round"/>
                    <circle cx="10" cy="10" r="2.4" stroke="#98A2B3" stroke-width="1.4"/>
                    <path d="M3.5 3.5 16.5 16.5" stroke="#98A2B3" stroke-width="1.4" stroke-linecap="round"/>
                  </svg>
                </button>
              </div>
            </div>

            <!-- 记住我 / 忘记密码 -->
            <div class="form__row">
              <label class="check">
                <input v-model="remember" type="checkbox" id="remember" />
                <span class="check__box">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1.5 5.2 3.8 7.5 8.5 2.8" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </span>
                <span class="check__text">{{ cfg.remember }}</span>
              </label>
              <a class="link" href="#">忘记密码？</a>
            </div>

            <!-- 提示条 -->
            <div v-if="alertState" class="alert" :class="`alert--${alertState.kind}`">
              <svg v-if="alertState.kind === 'error'" width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7" cy="7" r="6" stroke="#DC2626" stroke-width="1.3"/>
                <path d="M7 3.8v3.6" stroke="#DC2626" stroke-width="1.3" stroke-linecap="round"/>
                <circle cx="7" cy="9.9" r="0.8" fill="#DC2626"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7" cy="7" r="6" stroke="#12A150" stroke-width="1.3"/>
                <path d="M4 7.2 6 9.2 10 5" stroke="#12A150" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>{{ alertState.text }}</span>
            </div>

            <!-- 主行动 -->
            <button class="pill" :class="{ 'is-loading': loading, 'is-done': done }" type="submit" :disabled="loading">
              <span class="pill__bg"></span>
              <span class="pill__text pill__text--rest">登 录</span>
              <span class="pill__text pill__text--hover">
                登 录
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="pill__loading"><span class="spinner"></span>登录中…</span>
            </button>

            <!-- 社交 + 页脚 -->
            <div class="form__foot">
              <button class="social" type="button">
                <svg class="icon--wechat" width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8 2C4.7 2 2 4.2 2 7c0 1.6.8 3 2.1 3.9l-.5 1.8 1.9-1c.8.2 1.6.3 2.5.3 3.3 0 6-2.2 6-5s-2.7-5-6-5Z" stroke="#07C160" stroke-width="1.4" stroke-linejoin="round"/>
                  <circle cx="6" cy="6.4" r="0.9" fill="#07C160"/>
                  <circle cx="10" cy="6.4" r="0.9" fill="#07C160"/>
                </svg>
                <svg class="icon--qr" width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="2" width="6" height="6" rx="1.6" stroke="#2D5BE3" stroke-width="1.4"/>
                  <rect x="12" y="2" width="6" height="6" rx="1.6" stroke="#2D5BE3" stroke-width="1.4"/>
                  <rect x="2" y="12" width="6" height="6" rx="1.6" stroke="#2D5BE3" stroke-width="1.4"/>
                  <path d="M12 12h2.6v2.6H12z" fill="#2D5BE3"/>
                  <path d="M16.6 12H18v2.6M12 16.6v1.4h2.6M16.6 16.6H18V18h-1.4" stroke="#2D5BE3" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
                <span>{{ cfg.social }}</span>
              </button>

              <div class="form__signup">
                <span>{{ cfg.footA }}</span>
                <a href="#">{{ cfg.footB }}</a>
              </div>
            </div>
          </div>
        </form>
      </div>
    </main>
  </div>
</template>
