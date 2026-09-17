# Phase 2 中台触发功能实现总结

## 功能概述

本次实现了"中台触发 + 自动回执"功能（对应设计文档 `channel-publish-seamless.md` Phase 2），允许用户在中台页面直接点击"发布到 BOSS"按钮，扩展自动完成表单填充、发布监听和回执回传的完整闭环。

## 实现时间

2026-09-17

## 核心变更

### 1. 扩展端 (extension/)

#### 1.1 background.js

**修复内容：**

- **修复消息格式不一致问题**（5 处）：所有错误场景的 FILL_RESULT 消息中，`summary` 字段统一从 `{updated: 0, failed: 0}` 改为 `{total: 0, filled: 0, skipped: 0, failed: 0}`，与成功场景保持一致
  - 行 207：获取草稿失败 - HTTP 错误
  - 行 223：获取草稿失败 - 业务错误
  - 行 239：草稿数据格式错误
  - 行 256：未找到匹配的 recordId
  - 行 307：填充任务执行失败

**已有功能：**
- Phase 2 填充请求处理（`handleFillRequest`）：
  - 接收 FILL_REQUEST 消息
  - 调用 `/api/ext/drafts?status=pending` 获取草稿数据
  - 发送 FILL_PROGRESS 进度通知
  - 执行填充任务（复用 `runFillTask`）
  - 注入哨兵脚本（如果配置了 success）
  - 发送 FILL_RESULT 结果通知

#### 1.2 content/bridge.js

**修复内容：**

- **删除消息无限循环逻辑**（行 70-83）：移除了冗余的消息转发监听器，该监听器会接收 message-relay 发来的 FILL_PROGRESS/FILL_RESULT 消息后再次转发，导致自己监听到自己发送的消息，形成无限循环

**保留功能：**
- Phase 1：零配置授权心跳
- Phase 2：扩展就绪心跳（EXT_READY，每 5 秒）
- Phase 2：监听页面 FILL_REQUEST，转发给 message-relay

**修复原理：**
- 消息流向应该是：background → message-relay → 页面
- bridge.js 不应该参与 background → 页面的消息转发
- 删除重复转发逻辑后，消息流向清晰，不再循环

#### 1.3 content/message-relay.js

**状态：无变更**

正常工作，负责双向转发：
- 页面 → background：FILL_REQUEST
- background → 页面：FILL_PROGRESS / FILL_RESULT / PUBLISH_BACK

#### 1.4 content/sentinel.js

**状态：无变更**

正常工作，负责：
- 监听发布成功信号（URL 变化 + CSS 选择器）
- 调用 `/api/ext/records/{id}/report` 回填
- 向 background 发送 SENTINEL_SUCCESS
- background 广播 PUBLISH_BACK 给中台页面

### 2. 前端 (recruit-web/)

#### 2.1 src/composables/useExtensionBridge.ts

**修复内容：**

- **修复 FILL_PROGRESS 覆盖终态问题**（行 196-204）：
  - 在 FILL_PROGRESS 消息处理中，增加终态检查
  - 如果当前状态已经是 `filled` 或 `registered`，忽略后续的 FILL_PROGRESS 消息
  - 只有当前状态是 `filling` 或未设置时，才更新为 `filling`

**已有功能：**
- 监听扩展心跳（EXT_READY，15s 超时判定未安装）
- 监听填充进度、结果、回执消息
- 提供 `sendFillRequest` 方法，带防重复点击保护
- 维护按钮状态机（not_installed / ready / filling / filled / registered）
- 提供 `getButtonState` 方法，返回按钮的 UI 状态

#### 2.2 src/pages/hr-requests/HrRequestListPage.vue

**已有功能（无变更）：**
- 加载招聘需求列表
- 加载待发布草稿（BOSS 渠道，channelId = `2099758705647771650`）
- 根据 `getButtonState` 渲染按钮
- 点击按钮时调用 `sendFillRequest(recordId)`

### 3. 后端 (recruit-server/)

**状态：无变更**

已实现的接口：
- `GET /api/ext/drafts?status=pending`：获取待发布草稿列表
- `POST /api/ext/records/{id}/report`：回填发布结果
- `POST /api/extension/session-token`：零配置授权换权

## 问题修复记录

### 问题 1：按钮状态不稳定

**现象：**
点击"发布到 BOSS"后，按钮短暂显示"已填充"，然后又变回"正在后台填充..."

**根因：**
扩展 background.js 在填充完成后，会先发送 FILL_RESULT（状态变为 `filled`），但紧接着又发送了多个 FILL_PROGRESS 消息，导致状态被覆盖回 `filling`。

**解决方案：**
在 useExtensionBridge.ts 的 FILL_PROGRESS 消息处理中，增加终态保护，如果当前状态已经是 `filled` 或 `registered`，则忽略后续的 FILL_PROGRESS 消息。

### 问题 2：消息无限循环

**现象：**
控制台不断输出相同的 FILL_PROGRESS 和 FILL_RESULT 消息，recordId 相同，内容重复。

**根因：**
bridge.js 中存在一个消息转发监听器（行 71-83），它会：
1. 接收 message-relay 发来的消息（source = 'recruit-extension'）
2. 再次调用 `window.postMessage` 转发给页面
3. 由于消息的 source 仍然是 'recruit-extension'，该监听器会再次接收到
4. 形成无限循环

**解决方案：**
删除 bridge.js 中的冗余消息转发逻辑（行 70-83）。消息流向应该是：
- background → message-relay → 页面（useExtensionBridge 监听）
- bridge.js 不参与 background → 页面的消息转发

### 问题 3：消息格式不一致

**现象：**
错误场景的 FILL_RESULT 消息中，`summary` 字段格式与成功场景不一致，可能导致前端解析错误。

**根因：**
background.js 中有 5 处错误处理代码使用了旧格式 `{updated: 0, failed: 0}`，而成功场景使用的是 `{total: 0, filled: 0, skipped: 0, failed: 0}`。

**解决方案：**
统一所有 FILL_RESULT 消息的 `summary` 格式为 `{total, filled, skipped, failed}`，确保前端类型安全。

## 安全检查

### 1. 授权机制
- ✅ 扩展通过 `X-Extension-Token` 请求头认证
- ✅ Token 存储在 `chrome.storage.local`
- ✅ 零配置授权使用中台 JWT token 换权
- ✅ 支持 token 复用，避免多设备互踢

### 2. 消息来源验证
- ✅ bridge.js 只处理 `source === 'recruit-platform'` 的消息
- ✅ useExtensionBridge 只处理 `source === 'recruit-extension'` 的消息
- ✅ message-relay 只转发 `source === 'recruit-bridge'` 的消息
- ✅ postMessage 使用 `window.location.origin`，不使用 `'*'`

### 3. 数据泄露风险
- ✅ 无敏感信息输出到 console.log
- ✅ Token 不在消息中明文传输（存储在 storage）
- ✅ 草稿数据仅在授权用户可见（后端按 userId 过滤）

### 4. 注入风险
- ✅ 哨兵配置通过 `chrome.scripting.executeScript` 注入，不经过 DOM
- ✅ 填充配置同样通过 `executeScript` 注入
- ✅ URL pattern 使用简单通配符，正则转义正确

## 测试建议

### 1. 正常流程测试
1. 打开中台页面 http://localhost:8430/hr-requests
2. 确认按钮显示"发布到 BOSS"（扩展已安装）
3. 点击按钮
4. 观察按钮状态变化：正在后台填充... → 已填充
5. 切换到 BOSS 页面，确认表单已填充
6. 在 BOSS 页面点击提交（手动）
7. 观察中台按钮状态变化：已填充 → 已登记

### 2. 异常场景测试
1. 扩展未安装：按钮置灰，显示"发布到 BOSS"，tooltip 提示安装
2. 扩展已安装但未授权：点击按钮后显示错误提示
3. 草稿不存在：点击按钮后显示"未找到草稿"
4. 重复点击：第二次点击应被忽略，console 输出警告

### 3. 边界条件测试
1. 网络断开：填充失败，按钮恢复就绪状态
2. 页面刷新：按钮状态应根据 recordId 恢复
3. 多个草稿：每个草稿的按钮状态独立

## 遗留问题

无

## 下一步工作

- Phase 3：闭环优化（可选）
  - 发布成功后自动刷新列表
  - Toast 提示用户发布结果
  - 支持批量发布

## 相关文档

- 设计文档：[docs/design/channel-publish-seamless.md](../design/channel-publish-seamless.md)
- 架构文档：[docs/architecture/overview.md](../architecture/overview.md)
- ADR-008：[资源级归属授权](../architecture/adr/ADR-008-resource-ownership-authorization.md)

## 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---------|---------|------|
| extension/background.js | 修复 | 统一 FILL_RESULT.summary 格式（5 处） |
| extension/content/bridge.js | 修复 | 删除消息无限循环逻辑 |
| recruit-web/src/composables/useExtensionBridge.ts | 修复 | 防止 FILL_PROGRESS 覆盖终态 |
| docs/implementation/phase2-platform-trigger.md | 新增 | 本文档 |
