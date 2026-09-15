import { type Ref } from 'vue';

/**
 * 登录页几何角色动画引擎 —— 移植自设计稿原型《登录页 v3》。
 * 姿态沿用 CareerCompass《AnimatedCharacters》：
 *   isTyping   账号框聚焦          → 紫角色升到 440 + skewX(bodySkew-12) + 右移 40（凑近看）
 *   isHiding   密码已输入且遮蔽    → 紫角色落回 400 + skewX(12) + 左移 40（扭头背过），
 *                                   全部角色闭眼，瞳孔不再跟随鼠标
 *   isPlain    密码已输入且明文    → 全角色 skewX(0) 立正，紫角色周期性偷瞄
 * 驱动方式：事件 → 写 inline style → 交给 CSS transition 插值（不逐帧轮询）。
 */

export interface StageRefs {
  stage: Ref<HTMLElement | null>;
  charPurple: Ref<HTMLElement | null>;
  charBlack: Ref<HTMLElement | null>;
  charOrange: Ref<HTMLElement | null>;
  charYellow: Ref<HTMLElement | null>;
  eyesPurple: Ref<HTMLElement | null>;
  eyesBlack: Ref<HTMLElement | null>;
  eyesOrange: Ref<HTMLElement | null>;
  eyesYellow: Ref<HTMLElement | null>;
  mouthYellow: Ref<HTMLElement | null>;
}

export interface StageState {
  isTyping: Ref<boolean>;
  passwordLength: Ref<number>;
  showPassword: Ref<boolean>;
}

interface CharEntry {
  el: HTMLElement;
  eyes: HTMLElement;
  pupils: HTMLElement[];
  left: number;
  width: number;
  height: number;
  gap: number;
  eyeSize?: number;
  pupilSize: number;
  maxDist: number;
  _baseL?: number;
  _baseT?: number;
  _h?: number;
}

/** 眼睛组基准位置：[left, top]（away = 隐藏态下把眼睛挪向背离表单的一侧） */
const EYES: Record<'purple' | 'black' | 'orange' | 'yellow', Record<string, [number, number]>> = {
  purple: { plain: [20, 35], together: [55, 65], follow: [45, 40], away: [30, 37] },
  black: { plain: [10, 28], together: [32, 12], follow: [26, 32], away: [14, 29] },
  orange: { plain: [50, 85], follow: [82, 90], away: [62, 87] },
  yellow: { plain: [20, 35], follow: [52, 40], away: [34, 37] },
};

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : (v > max ? max : v);
}

export function useCharacterStage(refs: StageRefs, state: StageState) {
  let chars: Record<'purple' | 'black' | 'orange' | 'yellow', CharEntry> | null = null;
  let stageEl: HTMLElement | null = null;
  let stageBox: { left: number; top: number; height: number } | null = null;
  let hiding = false;
  let isLookingAtEachOther = false;
  let isPurplePeeking = false;
  let togetherTimer: ReturnType<typeof setTimeout> | null = null;
  let peekTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  let mouseX = 0;
  let mouseY = 0;
  let hasPointer = false;
  let moveQueued = false;

  function isHiding(): boolean {
    return state.passwordLength.value > 0 && !state.showPassword.value;
  }

  function isPlain(): boolean {
    return state.passwordLength.value > 0 && state.showPassword.value;
  }

  function measure(): void {
    if (!stageEl) return;
    const r = stageEl.getBoundingClientRect();
    stageBox = { left: r.left, top: r.top, height: r.height };
  }

  /** 参照稿 calculatePosition()：faceX ±15 / faceY ±10 / bodySkew ±6 */
  function calcPosition(c: CharEntry, h: number): { faceX: number; faceY: number; bodySkew: number } {
    if (!stageBox) return { faceX: 0, faceY: 0, bodySkew: 0 };
    const cx = stageBox.left + c.left + c.width / 2;
    const cy = stageBox.top + stageBox.height - h + h / 3;
    const dX = mouseX - cx;
    const dY = mouseY - cy;
    return {
      faceX: clamp(dX / 20, -15, 15),
      faceY: clamp(dY / 30, -10, 10),
      bodySkew: clamp(-dX / 120, -6, 6),
    };
  }

  /** 参照稿 calculatePupilPosition()：限定最大位移后按角度投射 */
  function pupilOffset(
    cx: number,
    cy: number,
    maxDist: number,
    forceX?: number,
    forceY?: number,
  ): { x: number; y: number } {
    if (forceX !== undefined && forceY !== undefined) return { x: forceX, y: forceY };
    if (!hasPointer) return { x: 0, y: 0 };
    const dX = mouseX - cx;
    const dY = mouseY - cy;
    const dist = Math.min(Math.sqrt(dX * dX + dY * dY), maxDist);
    const ang = Math.atan2(dY, dX);
    return { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist };
  }

  /** 画一个角色的眼睛：基准位置走 left/top（姿态切换时变），鼠标偏移走 transform */
  function paintEyes(
    c: CharEntry,
    base: [number, number],
    offset: [number, number],
    forceLook: [number, number] | null,
    h: number,
  ): void {
    if (!stageBox) return;
    if (c._baseL !== base[0]) {
      c.eyes.style.left = `${base[0]}px`;
      c._baseL = base[0];
    }
    if (c._baseT !== base[1]) {
      c.eyes.style.top = `${base[1]}px`;
      c._baseT = base[1];
    }
    c.eyes.style.transform = `translate(${offset[0].toFixed(2)}px,${offset[1].toFixed(2)}px)`;

    const size = c.eyeSize ?? c.pupilSize;
    const x0 = stageBox.left + c.left + base[0] + size / 2;
    const y0 = stageBox.top + stageBox.height - h + base[1] + size / 2;
    for (let i = 0; i < c.pupils.length; i++) {
      const p = pupilOffset(
        x0 + i * (size + c.gap),
        y0,
        c.maxDist,
        forceLook ? forceLook[0] : undefined,
        forceLook ? forceLook[1] : undefined,
      );
      c.pupils[i].style.transform = `translate(${p.x.toFixed(2)}px,${p.y.toFixed(2)}px)`;
    }
  }

  function renderStage(): void {
    if (!chars || !stageEl) return;
    if (!stageBox) measure();

    const nowHiding = isHiding();
    if (hiding !== nowHiding) {
      stageEl.classList.toggle('is-hiding', nowHiding);
      hiding = nowHiding;
    }

    const isTyping = state.isTyping.value;
    const plain = isPlain();
    // 隐藏态不再抬身（抬身＝凑近看）；「扭头背过」本身就是姿态变化
    const hP = isTyping ? 440 : 400;
    let tb: [number, number];
    let to: [number, number];
    let tf: [number, number] | null;

    /* ---- 角色1 · 紫（后层）---- */
    const p = calcPosition(chars.purple, hP);
    if (nowHiding) {
      tb = EYES.purple.away; to = [0, 0]; tf = [0, 0];
    } else if (plain) {
      tb = EYES.purple.plain; to = [0, 0]; tf = isPurplePeeking ? [4, 5] : [-4, -4];
    } else if (isLookingAtEachOther) {
      tb = EYES.purple.together; to = [0, 0]; tf = [3, 4];
    } else {
      tb = EYES.purple.follow; to = [p.faceX, p.faceY]; tf = null;
    }

    if (chars.purple._h !== hP) {
      chars.purple.el.style.height = `${hP}px`;
      chars.purple._h = hP;
    }
    chars.purple.el.style.transform = nowHiding
      ? 'skewX(12deg) translateX(-40px)'
      : plain
        ? 'skewX(0deg)'
        : isTyping
          ? `skewX(${p.bodySkew - 12}deg) translateX(40px)`
          : `skewX(${p.bodySkew}deg)`;
    paintEyes(chars.purple, tb, to, tf, hP);

    /* ---- 角色2 · 黑（中层）---- */
    const b = calcPosition(chars.black, chars.black.height);
    if (nowHiding) {
      tb = EYES.black.away; to = [0, 0]; tf = [0, 0];
    } else if (plain) {
      tb = EYES.black.plain; to = [0, 0]; tf = [-4, -4];
    } else if (isLookingAtEachOther) {
      tb = EYES.black.together; to = [0, 0]; tf = [0, -4];
    } else {
      tb = EYES.black.follow; to = [b.faceX, b.faceY]; tf = null;
    }

    chars.black.el.style.transform = nowHiding
      ? 'skewX(10deg)'
      : plain
        ? 'skewX(0deg)'
        : isLookingAtEachOther
          ? `skewX(${b.bodySkew * 1.5 + 10}deg) translateX(20px)`
          : isTyping
            ? `skewX(${b.bodySkew * 1.5}deg)`
            : `skewX(${b.bodySkew}deg)`;
    paintEyes(chars.black, tb, to, tf, chars.black.height);

    /* ---- 角色3 · 橙（前左）---- */
    const o = calcPosition(chars.orange, chars.orange.height);
    chars.orange.el.style.transform = nowHiding
      ? 'skewX(8deg)'
      : plain
        ? 'skewX(0deg)'
        : `skewX(${o.bodySkew}deg)`;
    paintEyes(
      chars.orange,
      nowHiding ? EYES.orange.away : plain ? EYES.orange.plain : EYES.orange.follow,
      nowHiding ? [0, 0] : plain ? [0, 0] : [o.faceX, o.faceY],
      nowHiding ? [0, 0] : plain ? [-5, -4] : null,
      chars.orange.height,
    );

    /* ---- 角色4 · 黄（前右）---- */
    const y = calcPosition(chars.yellow, chars.yellow.height);
    chars.yellow.el.style.transform = nowHiding
      ? 'skewX(8deg)'
      : plain
        ? 'skewX(0deg)'
        : `skewX(${y.bodySkew}deg)`;
    paintEyes(
      chars.yellow,
      nowHiding ? EYES.yellow.away : plain ? EYES.yellow.plain : EYES.yellow.follow,
      nowHiding ? [0, 0] : plain ? [0, 0] : [y.faceX, y.faceY],
      nowHiding ? [0, 0] : plain ? [-5, -4] : null,
      chars.yellow.height,
    );

    const mouth = refs.mouthYellow.value;
    if (mouth) {
      const mBase: [number, number] = plain ? [10, 88] : [40, 88];
      const entry = chars.yellow as CharEntry & { _mbL?: number; _mbT?: number };
      if (entry._mbL !== mBase[0]) {
        mouth.style.left = `${mBase[0]}px`;
        entry._mbL = mBase[0];
      }
      if (entry._mbT !== mBase[1]) {
        mouth.style.top = `${mBase[1]}px`;
        entry._mbT = mBase[1];
      }
      mouth.style.transform = (nowHiding || plain)
        ? 'translate(0,0)'
        : `translate(${y.faceX.toFixed(2)}px,${y.faceY.toFixed(2)}px)`;
    }
  }

  /** 鼠标：rAF 合并；鼠标静止时完全不写样式 */
  function onPointerMove(e: PointerEvent): void {
    mouseX = e.clientX;
    mouseY = e.clientY;
    hasPointer = true;
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => {
      moveQueued = false;
      renderStage();
    });
  }

  function onResize(): void {
    measure();
    renderStage();
  }

  /** 眨眼：紫 / 黑各自独立，间隔 3–7s，持续 150ms（橙黄不眨） */
  function blinkLoop(eyes: HTMLElement[]): void {
    setTimeout(() => {
      if (stopped) return;
      for (const eye of eyes) eye.classList.add('is-blinking');
      setTimeout(() => {
        if (stopped) return;
        for (const eye of eyes) eye.classList.remove('is-blinking');
        blinkLoop(eyes);
      }, 150);
    }, Math.random() * 4000 + 3000);
  }

  /** 对视 800ms：账号框聚焦时触发一次 */
  function lookAtEachOther(): void {
    isLookingAtEachOther = true;
    renderStage();
    if (togetherTimer) clearTimeout(togetherTimer);
    togetherTimer = setTimeout(() => {
      isLookingAtEachOther = false;
      renderStage();
    }, 800);
  }

  function cancelLookTogether(): void {
    isLookingAtEachOther = false;
    if (togetherTimer) clearTimeout(togetherTimer);
    togetherTimer = null;
  }

  /** 偷瞄：密码已输入且为明文时，2–5s 一次，持续 800ms */
  function schedulePeek(): void {
    if (peekTimer) clearTimeout(peekTimer);
    if (!isPlain()) {
      isPurplePeeking = false;
      return;
    }
    peekTimer = setTimeout(() => {
      isPurplePeeking = true;
      renderStage();
      setTimeout(() => {
        isPurplePeeking = false;
        renderStage();
        schedulePeek();
      }, 800);
    }, Math.random() * 3000 + 2000);
  }

  /** onMounted 时调用：收集 DOM、绑定事件、启动眨眼 */
  function init(): void {
    const stage = refs.stage.value;
    const el = (r: Ref<HTMLElement | null>): HTMLElement => {
      const v = r.value;
      if (!v) throw new Error('角色舞台元素未挂载');
      return v;
    };
    stageEl = stage;
    chars = {
      purple: {
        el: el(refs.charPurple), eyes: el(refs.eyesPurple),
        pupils: Array.from(el(refs.eyesPurple).querySelectorAll('.eye')),
        left: 70, width: 180, height: 400, gap: 32, eyeSize: 18, pupilSize: 7, maxDist: 5,
      },
      black: {
        el: el(refs.charBlack), eyes: el(refs.eyesBlack),
        pupils: Array.from(el(refs.eyesBlack).querySelectorAll('.eye')),
        left: 240, width: 120, height: 310, gap: 24, eyeSize: 16, pupilSize: 6, maxDist: 4,
      },
      orange: {
        el: el(refs.charOrange), eyes: el(refs.eyesOrange),
        pupils: Array.from(el(refs.eyesOrange).querySelectorAll('.dot')),
        left: 0, width: 240, height: 200, gap: 32, pupilSize: 12, maxDist: 5,
      },
      yellow: {
        el: el(refs.charYellow), eyes: el(refs.eyesYellow),
        pupils: Array.from(el(refs.eyesYellow).querySelectorAll('.dot')),
        left: 310, width: 140, height: 230, gap: 24, pupilSize: 12, maxDist: 5,
      },
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', onResize);

    measure();
    renderStage(); // 首屏保持直立 idle 姿态（不自动聚焦输入框）

    blinkLoop(chars.purple.pupils);
    blinkLoop(chars.black.pupils);

    // 字体加载会微调左区布局，就绪后再校准一次几何缓存（原型用 window load）
    document.fonts.ready.then(() => {
      measure();
      renderStage();
    });
  }

  /** onBeforeUnmount 时调用：解绑事件、停掉全部定时器 */
  function destroy(): void {
    stopped = true;
    document.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('resize', onResize);
    if (togetherTimer) clearTimeout(togetherTimer);
    if (peekTimer) clearTimeout(peekTimer);
    stageEl = null;
    chars = null;
    stageBox = null;
  }

  return { init, destroy, renderStage, lookAtEachOther, cancelLookTogether, schedulePeek };
}
