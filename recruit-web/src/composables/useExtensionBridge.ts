import { ref, onMounted, onUnmounted, type Ref } from 'vue';

/**
 * 扩展 bridge 协议类型定义（见设计文档 §5.1）
 * 
 * 页面 → 扩展：FILL_REQUEST
 * 扩展 → 页面：EXT_READY / FILL_PROGRESS / FILL_RESULT / PUBLISH_BACK
 */

export type ExtensionMessageType = 
  | 'FILL_REQUEST'
  | 'EXT_READY'
  | 'FILL_PROGRESS'
  | 'FILL_RESULT'
  | 'PUBLISH_BACK';

export interface ExtensionMessage<T = unknown> {
  source: 'recruit-platform' | 'recruit-extension';
  type: ExtensionMessageType;
  payload: T;
}

export interface FillRequestPayload {
  recordId: string;
}

export interface ExtReadyPayload {
  version: string;
}

export interface FillProgressPayload {
  recordId: string;
  phase: string;
}

export interface FillResultPayload {
  recordId: string;
  summary: { total: number; filled: number; skipped: number; failed: number };
  ok: boolean;
}

export interface PublishBackPayload {
  recordId: string;
  status: 'published' | 'failed';
  publishedUrl?: string;
}

/**
 * 按钮状态（见设计文档 §5.2）
 */
export type ButtonState = 
  | 'not_installed'  // 未安装：15s 未收到心跳
  | 'ready'          // 就绪：收到 EXT_READY
  | 'filling'        // 填充中：发送 FILL_REQUEST 后
  | 'filled'         // 待提交：收到 FILL_RESULT 且 updated > 0
  | 'registered';    // 已登记：收到 PUBLISH_BACK

export interface ButtonStateInfo {
  state: ButtonState;
  disabled: boolean;
  loading: boolean;
  text: string;
  tooltip?: string;
}

/**
 * 扩展 bridge 通信 hook
 * 
 * 功能：
 * 1. 监听扩展心跳（EXT_READY，15s 超时判定未安装）
 * 2. 监听填充进度、结果、回执消息
 * 3. 提供发送 FILL_REQUEST 的方法
 * 4. 维护按钮状态机
 */
export function useExtensionBridge() {
  const buttonState: Ref<ButtonState> = ref('not_installed');
  const extensionVersion: Ref<string> = ref('');
  const lastHeartbeat: Ref<number> = ref(0);
  
  // 记录每个 recordId 的填充状态
  const fillStates = ref<Map<string, { state: ButtonState; result?: FillResultPayload }>>(new Map());

  // 心跳超时定时器
  let heartbeatTimer: number | null = null;

  /**
   * 获取指定 recordId 的按钮状态
   */
  function getButtonState(recordId: string): ButtonStateInfo {
    const globalState = buttonState.value;
    const fillState = fillStates.value.get(recordId);

    // 如果扩展未安装，所有按钮都置灰
    if (globalState === 'not_installed') {
      return {
        state: 'not_installed',
        disabled: true,
        loading: false,
        text: '发布到 BOSS',
        tooltip: '未检测到发布助手，点击查看安装指引',
      };
    }

    // 如果该 recordId 有特定状态，使用特定状态
    if (fillState) {
      switch (fillState.state) {
        case 'filling':
          return {
            state: 'filling',
            disabled: true,
            loading: true,
            text: '正在后台填充…',
          };
        case 'filled':
          return {
            state: 'filled',
            disabled: false,
            loading: false,
            text: '已填充',
            tooltip: '已填充，请在 BOSS 页面核对后提交',
          };
        case 'registered':
          return {
            state: 'registered',
            disabled: true,
            loading: false,
            text: '已登记',
          };
        default:
          break;
      }
    }

    // 默认就绪状态
    return {
      state: 'ready',
      disabled: false,
      loading: false,
      text: '发布到 BOSS',
    };
  }

  /**
   * 发送 FILL_REQUEST 消息到扩展
   */
  function sendFillRequest(recordId: string): void {
    // 防重复点击：如果已经在填充中或已完成，忽略
    const currentState = fillStates.value.get(recordId);
    if (currentState && (currentState.state === 'filling' || currentState.state === 'filled' || currentState.state === 'registered')) {
      console.warn('⚠️ 任务进行中或已完成，忽略重复请求', { recordId, state: currentState.state });
      return;
    }

    const message: ExtensionMessage<FillRequestPayload> = {
      source: 'recruit-platform',
      type: 'FILL_REQUEST',
      payload: { recordId },
    };

    // 更新状态为填充中
    fillStates.value.set(recordId, { state: 'filling' });

    // 发送消息（targetOrigin 写死中台域名，不写 '*'）
    window.postMessage(message, window.location.origin);
  }

  /**
   * 处理扩展消息
   */
  function handleExtensionMessage(event: MessageEvent): void {
    const message = event.data as ExtensionMessage;

    // 验证消息来源
    if (!message || message.source !== 'recruit-extension') {
      return;
    }

    switch (message.type) {
      case 'EXT_READY': {
        const payload = message.payload as ExtReadyPayload;
        buttonState.value = 'ready';
        extensionVersion.value = payload.version;
        lastHeartbeat.value = Date.now();

        // 重置心跳定时器
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
        }
        heartbeatTimer = setTimeout(() => {
          buttonState.value = 'not_installed';
        }, 15000); // 15s 超时

        break;
      }

      case 'FILL_PROGRESS': {
        const payload = message.payload as FillProgressPayload;
        // 只有当前状态不是终态时才更新为 filling
        const current = fillStates.value.get(payload.recordId);
        if (!current || current.state === 'filling') {
          fillStates.value.set(payload.recordId, { state: 'filling' });
        }
        // 如果已经是 filled 或 registered，忽略后续的 FILL_PROGRESS
        break;
      }

      case 'FILL_RESULT': {
        const payload = message.payload as FillResultPayload;
        if (payload.summary && payload.summary.filled > 0) {
          fillStates.value.set(payload.recordId, { state: 'filled', result: payload });
          console.info('✅ 填充完成', {
            recordId: payload.recordId,
            已填充: payload.summary.filled,
            跳过: payload.summary.skipped,
            失败: payload.summary.failed,
            总计: payload.summary.total,
          });
        } else {
          // 没有更新字段，回到就绪状态
          fillStates.value.delete(payload.recordId);
          console.warn('⚠️ 填充未生效', { recordId: payload.recordId, summary: payload.summary });
        }
        break;
      }

      case 'PUBLISH_BACK': {
        const payload = message.payload as PublishBackPayload;
        fillStates.value.set(payload.recordId, { state: 'registered' });
        
        // 可以触发页面刷新或 toast 提示
        console.info('发布回执', payload);
        break;
      }
    }
  }

  onMounted(() => {
    window.addEventListener('message', handleExtensionMessage);
    
    // 初始判定为未安装，等待首次心跳
    heartbeatTimer = setTimeout(() => {
      if (buttonState.value !== 'ready') {
        buttonState.value = 'not_installed';
      }
    }, 15000);
  });

  onUnmounted(() => {
    window.removeEventListener('message', handleExtensionMessage);
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
  });

  return {
    buttonState,
    extensionVersion,
    getButtonState,
    sendFillRequest,
  };
}
