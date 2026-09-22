# 扩展故障排查指南

## 0. 中台部署到远端后「检测不到插件」+ `Extension context invalidated`

> 2026-09-21 实测：服务部署到 `118.145.246.201` 后，扩展 popup 能拉到待发布草稿，
> 但中台页面判定「未检测到发布助手」；控制台同时报
> `Extension context invalidated`。

### 症状 → 根因对照

| 症状 | 根因 | 是否已修 |
|---|---|---|
| 中台页面始终显示「未检测到发布助手」，按钮灰色 | `manifest.json` 的 `content_scripts.matches` 只写了本地开发地址，**部署后的 origin 不在清单里** → content script 不注入 → 页面收不到 `EXT_READY` 心跳，15s 后判定未安装 | ✅ 已加入 `http://118.145.246.201/*` |
| 后台全部请求（换权/拉草稿/回填/采集入库）打不通 | `background.js` 里 `API_BASE` 是**编译期常量** `http://localhost:6017`，忽略了配置页保存的 `baseUrl` | ✅ 改为 `getApiBase()`，读 `chrome.storage.local.baseUrl` |
| `Extension context invalidated` | 扩展被重载/更新后，**已注入页面的旧 content script 变成孤儿**（`chrome.runtime.id` 置空），再调 `chrome.*` 就抛这个错 | ✅ 见下方「孤儿 content script」处理 |

### 更换部署地址要改哪几处（`extension/`）

1. `manifest.json`
   - `content_scripts[中台].matches`：加上中台前端的实际 origin
   - `host_permissions`：加上中台/后端实际 origin
2. 扩展「选项页」（`chrome://extensions` → 扩展详情 → 扩展选项）：后端地址填实际 API 地址
   （这一步只改配置、不用改代码；`background.js` 现在会读它）
3. 改完在 `chrome://extensions` 点 🔄 重新加载扩展，**并刷新中台页面**

> 漏掉第 1 步 → content script 不注入，页面永远检测不到扩展；
> 漏掉第 2 步 → popup 能用、但填充/采集等链路仍打到 localhost。

### 孤儿 content script（`Extension context invalidated`）

**为什么会这样**：每次重载/更新扩展，只有"新建的页面"会注入新版 content script；
已经打开的老页面里跑的还是旧实例，它们持有的扩展上下文已被销毁。

**现在的降级行为**（`content/message-relay.js`、`content/bridge.js`）：
- 每次心跳/转发前检查 `chrome.runtime.id`
- 失效则停掉定时器，向页面广播一条 `EXT_UNAVAILABLE`
- 中台 UI 收到后把按钮置灰并提示 **「扩展刚更新过，请刷新本页面后重试」**，而不是笼统的"未安装"
- 不再向控制台持续刷 `Extension context invalidated`

**用户侧处置**：刷新页面即可。若刷新后仍无效，确认 `chrome://extensions` 里扩展是启用状态、
且中台 origin 命中 `matches`。

### 0.1 选项页「测试连接」报 `Failed to fetch`

> 2026-09-22 实测：后端地址填 `http://118.145.246.201`，点测试连接提示
> `无法连接后端（Failed to fetch），请检查地址与后端服务`；但同一地址 `curl` 能正常返回 401。

**不要被这句提示误导** —— 它不表示后端挂了，而是「浏览器在发请求之前就被拦下了」。
按顺序排除：

1. **CORS（已修）**：后端此前完全没有 CORS 配置。扩展跑在 `chrome-extension://<id>` 源下，
   属跨域；且 `X-Extension-Token` 是自定义头会触发预检 `OPTIONS`。
   现已在 `WebMvcConfig` 放行 `/api/ext/**`、`/api/extension/**`，并在三个拦截器里放行 OPTIONS 预检。
   自检：
   ```bash
   curl -i -X OPTIONS -H "Origin: chrome-extension://probe" \
        -H "Access-Control-Request-Method: GET" \
        -H "Access-Control-Request-Headers: x-extension-token" \
        http://<host>/api/ext/drafts
   ```
   期望 `HTTP/1.1 200` 且带 `Access-Control-Allow-Origin: chrome-extension://probe`。
   若返回 **401/403 且带业务 JSON body**，说明预检被拦截器拦了，浏览器会直接放弃。
2. **扩展 host_permissions**：manifest 里必须有目标 origin；改完必须在
   `chrome://extensions` 点 🔄 重载才是生效的那个 manifest。
3. **地址本身**：`curl -s -o /dev/null -w '%{http_code}' http://<host>/api/health` 应为 200。

> 三者症状完全一样（都是 Failed to fetch），curl 却是正常的 —— 这类「服务端干净、浏览器失败」
> 的故障，先怀疑 CORS 与权限，而不是后端服务。

---

### 0.2 改完代码「没生效」：先确认 Chrome 到底加载了哪个目录

> 2026-09-22 实测：本机同时存在两份克隆 —— `~/recruit-platform` 与 `~/recruit-platform-github`。
> 代码改在前者，Chrome 加载的却是后者的 `extension/`，于是「改了、重载了、还是不行」，
> 控制台里打印的还是旧代码。

**不要靠猜**，直接问浏览器。Chrome 把已加载的扩展记录在
`~/Library/Application Support/Google/Chrome/<Profile>/Secure Preferences` 里
（新版本不再放在 `Preferences`，翻旧文件会一无所获）：

```bash
python3 - <<'PY'
import json, glob, os
for pref in glob.glob(os.path.expanduser(
        '~/Library/Application Support/Google/Chrome/*/Secure Preferences')):
    data = json.load(open(pref, encoding='utf-8'))
    for eid, cfg in (data.get('extensions', {}).get('settings') or {}).items():
        p = cfg.get('path') or ''
        if p.startswith('/Users'):          # location=4 即「已解压加载」
            print(cfg.get('location'), p)
PY
```

命中路径若与你的工作目录不一致，**先 reload 的是哪份、改的是哪份**就对上了。
两个目录同名文件比对（一眼看出新旧）：

```bash
diff -r ~/recruit-platform/extension ~/recruit-platform-github/extension && echo 一致
```

> 建议：全机只保留一份克隆，其余删除或改名。多份克隆 + 解压式加载是「改了没反应」的头号原因。

---

### 0.3 控制台报 `Identifier 'xxx' has already been declared`

> 2026-09-22 事故：给 message-relay 与 bridge 都加了上下文存活检测后，页面报
> `Uncaught SyntaxError: Identifier 'contextDead' has already been declared (at bridge.js:1:1)`，
> **bridge 整支脚本没有运行** → 页面收不到 EXT_READY → 又变成「检测不到插件」。

**根因**：同一个 `content_scripts` 条目里的多个 `js` 文件，注入的是
**同一个隔离世界（isolated world）**，顶层作用域是共享的。两个文件各自写
`let contextDead` 就等于在同一作用域重复声明 —— 后执行的那支直接抛语法错误，
整支不运行（前面的 `if (window[FLAG]) return` 守卫也救不了，因为语法错误发生在
更早的解析阶段）。

**规矩**：extension/content/ 下的每个文件都必须整体包在 IIFE 里，不向顶层泄漏任何标识符。

```js
(() => {
  'use strict';
  // ... 全部逻辑
})();
```

同世界的文件组合（现状，均已包 IIFE）：
| 世界 | 文件组合 |
|---|---|
| 中台页面（5173/5176/118.145.246.201） | `message-relay.js` + `bridge.js` |
| BOSS 发布页 | `message-relay.js` + `sentinel.js` |
| BOSS 聊天/简历页 | `collect-bridge.js` + `collect-button.js` + `collect-hook.js`（MAIN 世界，独立） |

> `collect-*.js` 一直是 IIFE；2026-09-22 把 `message-relay.js` / `bridge.js` / `sentinel.js`
> 补齐，现在 content/ 下**没有任何文件向共享顶层作用域声明标识符**。

**回归测试**（改完 content script 先跑它，比在浏览器里点一遍快）：

```bash
node test/extension-content-world-verify.cjs
```

它把 message-relay.js 与 bridge.js 注入**同一个 vm 上下文**（复现真实隔离世界），验证 11 项：
正序/反序注入不抛错、EXT_READY 与换权通知正常发出、FILL_REQUEST 恰好转发一次（不双发）、
页面原始消息不被 relay 直接转发、重复注入时心跳与监听器不叠加。

> ⚠️ 这是「内容脚本互相打架」的典型形态，和 §0.2 的多份克隆一样，症状都是
> 「代码明明改了却没生效」，而报错位置（`bridge.js:1:1`）往往指向不了真凶。

---

### 一条命令自检 content script 是否注入

在中台页面 Console 里执行：

```javascript
console.log({
  origin: window.location.origin,
  bridgeInjected: !!window['recruit-extension-bridge'],
  runtimeAlive: typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id),
});
```

期望：`bridgeInjected: true`、`runtimeAlive: true`。
两者任一为 `false`，先看 `window.location.origin` 是否被 manifest 的 `matches` 覆盖。

---

## 问题：发布到 BOSS 按钮不工作

### 第一步：确认扩展已加载

1. 打开 Chrome 浏览器
2. 访问 `chrome://extensions/`
3. 检查：
   - ✅ 能看到"招聘发布助手"扩展
   - ✅ 右上角"开发者模式"已开启
   - ✅ 扩展的开关是**蓝色**（启用状态）
   - ✅ 没有红色错误提示

**如果有错误提示**，记录错误信息，可能是：
- manifest.json 配置错误
- 文件路径不对
- 权限问题

### 第二步：检查 content scripts 是否注入

1. 打开中台页面（本地 `http://localhost:5173`，远端 `http://118.145.246.201`）
2. 进入 HR 需求列表 `/hr-requests`
2. 按 `F12` 打开开发者工具
3. 切换到 **Console** 标签
4. 查找以下日志：

```
[Bridge] 初始化
[Bridge] 发送 EXT_READY: {...}
[Relay] 初始化
```

**如果看不到这些日志**，说明 content scripts 没有注入，可能原因：
- 扩展未启用
- URL 不匹配（检查 manifest.json 中的 matches）
- 需要刷新页面（`Cmd+R` 或 `Ctrl+R`）

### 第三步：检查按钮状态

在 HR 需求列表页面，观察"发布到 BOSS"按钮：

**正常状态（扩展工作中）**：
- 按钮是**橙色**（`bg-[#C4612F]`）
- 文字是"发布到 BOSS"
- 按钮可点击（不是灰色半透明）

**异常状态（扩展未工作）**：
- 按钮是**灰色**或半透明
- 可能显示"未检测到扩展"
- 按钮被禁用（`disabled`）

### 第四步：测试按钮点击

1. 点击一个橙色的"发布到 BOSS"按钮
2. 观察 Console，应该看到：

```
[Bridge] 收到 FILL_REQUEST: {recordId: "..."}
[Relay] 转发到 background: FILL_REQUEST
```

3. 同时观察按钮状态变化：
   - 立即变为"正在后台填充..."（粉色文字）
   - 按钮变为禁用状态

**如果点击后没有日志**：
- content scripts 可能没有正确监听 postMessage
- 消息格式可能不匹配

### 第五步：检查 background script

1. 在 `chrome://extensions/` 页面
2. 找到"招聘发布助手"扩展
3. 点击"service worker"链接（或"检查视图"）
4. 会打开 background script 的开发者工具
5. 查找日志：

```
[Background] 收到消息: FILL_REQUEST
[Background] 开始填充任务: recordId=...
```

**如果 background 没有收到消息**：
- message-relay.js 可能没有正确转发
- chrome.runtime.sendMessage 调用失败

### 第六步：检查网络请求

在前端页面的开发者工具中：

1. 切换到 **Network** 标签
2. 点击"发布到 BOSS"按钮
3. 应该看到：
   - `GET /api/hr-requests/{recordId}` - 获取需求详情
   - 扩展会打开新标签页到 BOSS 直聘

### 常见问题和解决方案

#### 问题 1：控制台没有 [Bridge] 日志

**原因**：content scripts 没有注入

**解决方案**：
1. 刷新页面（`Cmd+R`）
2. 如果还不行，重新加载扩展：
   - 到 `chrome://extensions/`
   - 点击"招聘发布助手"的刷新图标 🔄
   - 再次刷新页面

#### 问题 2：按钮一直是灰色

**原因**：前端没有收到 EXT_READY 心跳

**解决方案**：
1. 检查 Console 是否有 `[Bridge] 发送 EXT_READY`
2. 如果有，但按钮还是灰色，检查前端代码
3. 在 Console 执行：
   ```javascript
   window.postMessage({
     source: 'recruit-extension',
     type: 'EXT_READY',
     payload: { version: '0.1.0', timestamp: Date.now() }
   }, '*');
   ```
4. 如果按钮变成橙色，说明前端代码正常，问题在 bridge.js

#### 问题 3：点击按钮后卡在"正在后台填充..."

**原因**：background 没有响应或任务失败

**解决方案**：
1. 打开 background script 的开发者工具
2. 查看是否有错误
3. 检查后端 API 是否正常（`http://localhost:6017`）

#### 问题 4：manifest.json 配置问题

**检查清单**：
- `matches` 必须包含当前中台页面的 origin（`http://localhost:5173/*`、`http://localhost:5176/*`、
  `http://118.145.246.201/*`，详见本文 §0）
- `host_permissions` 必须包含中台与后端 API 的 origin
- `content_scripts` 的 `js` 数组顺序：`message-relay.js` 在前、`bridge.js` 在后（先建好到
  background 的通道，再让 bridge 往页面发消息）

## 调试技巧

### 查看所有 postMessage 消息

在 Console 中执行：

```javascript
const originalPostMessage = window.postMessage;
window.postMessage = function(...args) {
  console.log('[postMessage]', args[0]);
  return originalPostMessage.apply(this, args);
};
```

### 手动触发 FILL_REQUEST

在 Console 中执行：

```javascript
window.postMessage({
  source: 'recruit-platform',
  type: 'FILL_REQUEST',
  payload: { recordId: '你的recordId' }
}, window.location.origin);
```

### 检查扩展是否注入

在 Console 中执行：

```javascript
console.log({
  bridge: window['recruit-extension-bridge'],
  relay: window['recruit-message-relay'],
  chromeRuntime: typeof chrome !== 'undefined' && !!chrome.runtime
});
```

应该返回：
```javascript
{
  bridge: true,
  relay: true,
  chromeRuntime: true
}
```

## 需要帮助？

如果以上步骤都尝试过还是不行，请提供以下信息：

1. `chrome://extensions/` 的截图
2. Console 中的所有日志（包括错误）
3. Network 标签中的请求记录
4. 按钮的 HTML 结构（右键 -> 检查）
