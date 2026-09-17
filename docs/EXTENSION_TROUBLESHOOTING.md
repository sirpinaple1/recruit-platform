# 扩展故障排查指南

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

1. 打开 `http://localhost:8430/hr-requests`
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
- `matches` 必须包含 `"http://localhost:8430/*"`
- `host_permissions` 必须包含后端 API 地址
- `content_scripts` 的 `js` 数组顺序：先 `bridge.js`，后 `message-relay.js`

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
