# 扩展故障排查清单

## 问题：按钮一直置灰（显示"未检测到发布助手"）

### 排查步骤

#### 1. 检查扩展是否已加载

打开 Chrome：
```
chrome://extensions/
```

确认：
- ✅ "招聘发布助手" 扩展存在
- ✅ 开关已开启
- ✅ 显示版本号（应为 1.0.0 或更高）

**如果扩展不存在**：
- 点击"加载已解压的扩展程序"
- 选择项目的 `extension/` 目录

**如果扩展存在但有错误**：
- 点击扩展的"错误"按钮查看详情
- 检查 manifest.json 是否有语法错误

---

#### 2. 重新加载扩展

**必须操作**：每次修改扩展代码后，必须重新加载扩展！

在 `chrome://extensions/` 页面：
1. 找到"招聘发布助手"
2. 点击右下角的 🔄 刷新按钮
3. 等待 2-3 秒

---

#### 3. 刷新中台页面

**必须操作**：重新加载扩展后，必须刷新中台页面！

在 `http://localhost:8430/hr-requests` 页面：
1. 按 `Cmd+R`（Mac）或 `Ctrl+R`（Windows）刷新
2. 或者按 `Cmd+Shift+R` 强制刷新（清除缓存）

---

#### 4. 检查控制台日志

打开 Chrome DevTools（`Cmd+Option+J`）：

**期望看到的日志：**
```
[Bridge] 初始化
[Bridge] 检测到登录态，通知 background 换权
```

**每 5 秒应该出现：**
```
（EXT_READY 心跳消息，前端会接收但不打印）
```

**如果没有 "[Bridge] 初始化"：**
- bridge.js 没有注入
- 检查 manifest.json 的 `content_scripts.matches` 是否包含 `http://localhost:8430/*`

**如果有 "[Bridge] 初始化" 但没有其他日志：**
- 可能是 localStorage 中没有 `recruit_token`
- 检查是否已登录：`localStorage.getItem('recruit_token')`

---

#### 5. 检查前端是否收到心跳

在中台页面控制台执行：

```javascript
// 监听扩展消息
let heartbeatCount = 0;
window.addEventListener('message', (e) => {
  if (e.data && e.data.source === 'recruit-extension' && e.data.type === 'EXT_READY') {
    heartbeatCount++;
    console.log(`✅ 收到扩展心跳 #${heartbeatCount}`, e.data);
  }
});

// 等待 10 秒，应该收到 2 次心跳
setTimeout(() => {
  console.log(`总共收到 ${heartbeatCount} 次心跳（期望 >= 2）`);
}, 10000);
```

**期望结果：**
- 10 秒内至少收到 2 次 "✅ 收到扩展心跳" 消息

**如果没有收到心跳：**
- bridge.js 未注入或未执行
- 检查 manifest.json 的 `content_scripts` 配置

---

#### 6. 检查 manifest.json 配置

打开 `extension/manifest.json`，确认：

```json
{
  "content_scripts": [
    {
      "matches": [
        "http://localhost:8430/*",
        "https://www.zhipin.com/web/geek/job-recommend*",
        "https://www.zhipin.com/web/geek/job/publish*"
      ],
      "js": [
        "content/message-relay.js",
        "content/bridge.js"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

**关键点：**
- `matches` 必须包含 `http://localhost:8430/*`
- `js` 数组中 `bridge.js` 必须存在
- `run_at` 应为 `document_idle`（页面加载完成后注入）

---

#### 7. 检查前端代码是否最新

在中台页面控制台执行：

```javascript
// 检查 useExtensionBridge 是否已加载
console.log('前端代码版本检查：');
console.log('- buttonState 初始值:', buttonState?.value || '未定义');
console.log('- getButtonState 方法:', typeof getButtonState);
```

**如果提示 "未定义"：**
- 前端没有使用 useExtensionBridge
- 检查 HrRequestListPage.vue 是否导入并使用了该 hook

---

#### 8. 手动触发心跳测试

在中台页面控制台执行：

```javascript
// 手动发送心跳
window.postMessage({
  type: 'EXT_READY',
  source: 'recruit-extension',
  payload: {
    version: '1.0.0',
    timestamp: Date.now(),
  },
}, window.location.origin);

console.log('✅ 已手动发送 EXT_READY，检查按钮是否变为"发布到 BOSS"');
```

**如果按钮变为可用：**
- 说明前端逻辑正常，问题在于扩展未发送心跳
- 返回步骤 1-4 检查扩展

**如果按钮仍然置灰：**
- 前端代码可能有问题
- 检查 useExtensionBridge.ts 的实现

---

## 常见问题速查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| 按钮一直置灰 | 扩展未加载 | 检查 chrome://extensions/ |
| 按钮一直置灰 | 扩展已加载但未刷新 | 点击扩展的 🔄 刷新按钮 |
| 按钮一直置灰 | 页面未刷新 | 按 Cmd+Shift+R 强制刷新页面 |
| 控制台无 "[Bridge]" 日志 | bridge.js 未注入 | 检查 manifest.json matches |
| 收到心跳但按钮仍置灰 | 前端代码问题 | 检查 useExtensionBridge.ts |
| 点击按钮无反应 | FILL_REQUEST 未发送 | 检查 HrRequestListPage.vue |

---

## 完整重置流程

如果以上步骤都无效，尝试完整重置：

### 1. 清理旧扩展
```bash
# 在 chrome://extensions/ 中：
# 点击"招聘发布助手"的"移除"按钮
```

### 2. 清理浏览器缓存
```bash
# 在 Chrome DevTools 中（Cmd+Option+I）：
# 右键点击刷新按钮 → "清空缓存并硬性重新加载"
```

### 3. 重新加载扩展
```bash
# 在 chrome://extensions/ 中：
# 1. 开启"开发者模式"
# 2. 点击"加载已解压的扩展程序"
# 3. 选择项目的 extension/ 目录
```

### 4. 刷新前端
```bash
# 在中台页面：
# 按 Cmd+Shift+R 强制刷新
```

### 5. 验证
```bash
# 在控制台应该看到：
# [Bridge] 初始化
# [Bridge] 检测到登录态，通知 background 换权
```

---

## 仍然无法解决？

如果以上所有步骤都完成但问题仍存在，请提供：

1. Chrome 版本号（chrome://version/）
2. 扩展是否出现在 chrome://extensions/
3. 控制台完整日志（包含所有 [Bridge] 和错误信息）
4. manifest.json 的 content_scripts 配置
5. 手动触发心跳测试的结果

将这些信息发送给开发团队进行进一步排查。
