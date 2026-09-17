# Phase 1 零配置授权 - 集成验证指南

本文档描述如何验证 Phase 1（零配置授权）的实现效果。

## 前置条件

1. **后端服务已启动**（localhost:6017）
2. **前端服务已启动**（localhost:8430）
3. **数据库 extension_token 表已添加 expires_at 字段**
   - 执行 DDL：`recruit-server/sql/extension_token_alter_add_expires_20260916_V1.sql`
4. **扩展已加载到 Chrome**
   - 打开 `chrome://extensions/`
   - 开启"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择 `/Users/zhuanzmima0000/recruit-platform-github/extension` 目录

## 验证场景 1：首次打开中台自动获取 token

### 步骤

1. **清空扩展本地存储**（模拟首次使用）
   ```javascript
   // 打开 Chrome DevTools → Console，在扩展的 background 页面执行
   chrome.storage.local.clear()
   ```

2. **打开中台并登录**
   - 访问 http://localhost:8430
   - 使用 hr001 账号登录（或任何有效的 HR 账号）

3. **观察 DevTools Console**
   - 打开 Chrome DevTools（F12）
   - 切换到 Console 标签
   - 预期看到以下日志：
     ```
     [Bridge] 初始化
     [Bridge] 检测到登录态，通知 background 换权
     [MessageRelay] 转发登录态通知到 background
     [Background] 收到登录态通知，开始换权
     [Background] 新 token 已存储，tokenId: xxx, expiresAt: ...
     [Background] 换权完成
     ```

4. **验证 token 已存储**
   - 打开 Chrome DevTools → Application → Storage → Extension Storage
   - 选择扩展 ID
   - 预期看到 `ext_token` 字段，值为一串 Base64 编码的字符串

5. **验证后端日志**
   - 查看后端服务日志
   - 预期看到：
     ```
     扩展授权新签发：userId=xxx, tokenId=xxx, expiresAt=...
     ```

### 预期结果

✅ 用户登录中台后，扩展自动获取 token 并存储到本地，无需手动配置

---

## 验证场景 2：重启浏览器 token 复用

### 步骤

1. **记录当前 token**
   - 打开 Chrome DevTools → Application → Storage → Extension Storage
   - 复制 `ext_token` 的值（例如：`abc123...`）

2. **关闭并重启 Chrome 浏览器**

3. **重新打开中台**
   - 访问 http://localhost:8430
   - 确保已登录（同一账号）

4. **观察 DevTools Console**
   - 预期看到以下日志：
     ```
     [Bridge] 初始化
     [Bridge] 检测到登录态，通知 background 换权
     [MessageRelay] 转发登录态通知到 background
     [Background] 收到登录态通知，开始换权
     [Background] Token 复用，tokenId: xxx
     [Background] 换权完成
     ```

5. **验证 token 未变化**
   - 打开 Chrome DevTools → Application → Storage → Extension Storage
   - 预期 `ext_token` 的值与步骤 1 记录的相同

6. **验证后端日志**
   - 查看后端服务日志
   - 预期看到：
     ```
     扩展授权复用：userId=xxx, tokenId=xxx
     ```

### 预期结果

✅ 重启浏览器后，扩展复用现有 token，不会重新签发

---

## 验证场景 3：多设备同时使用

### 步骤

1. **在设备 A 上获取 token**
   - 按照场景 1 的步骤操作
   - 记录 tokenId（从后端日志或数据库查询）

2. **在设备 B 上获取 token**
   - 在另一台电脑或 Chrome Profile 上加载扩展
   - 按照场景 1 的步骤操作
   - 记录 tokenId

3. **验证设备 A 的 token 仍然有效**
   - 回到设备 A
   - 刷新中台页面
   - 预期看到 "Token 复用" 日志

4. **查询数据库**
   ```sql
   SELECT id, user_id, name, status, expires_at, created_at
   FROM extension_token
   WHERE user_id = <hr001_user_id>
   ORDER BY created_at DESC;
   ```
   - 预期看到两条 active 记录（设备 A 和设备 B 各一条）

### 预期结果

✅ 多设备同时使用时，每台设备持有独立的 token，互不踢出

---

## 验证场景 4：Token 过期后自动重新签发

### 步骤

1. **手动修改 token 过期时间**（模拟过期场景）
   ```sql
   UPDATE extension_token
   SET expires_at = NOW() - INTERVAL 1 DAY
   WHERE id = <token_id>;
   ```

2. **刷新中台页面**
   - 访问 http://localhost:8430
   - 预期看到 "扩展授权已过期，重新签发" 日志

3. **验证新 token 已存储**
   - 检查 Extension Storage，`ext_token` 的值已更新
   - 查询数据库，看到新的 token 记录（expires_at 为 30 天后）

### 预期结果

✅ Token 过期后，扩展自动重新签发新 token

---

## 验证场景 5：心跳维持

### 步骤

1. **打开中台并登录**

2. **等待 5 分钟以上**

3. **观察 DevTools Console**
   - 预期每 5 分钟看到一次：
     ```
     [Bridge] 检测到登录态，通知 background 换权
     [Background] Token 复用，tokenId: xxx
     ```

### 预期结果

✅ 扩展每 5 分钟自动检查登录态并尝试换权（复用现有 token）

---

## 故障排查

### 问题 1：Console 没有任何日志

**可能原因**：
- Content script 未注入

**解决方案**：
1. 检查扩展是否正确加载（`chrome://extensions/`）
2. 检查 manifest.json 的 content_scripts 配置是否正确
3. 刷新页面并检查 DevTools → Sources → Content scripts 是否有 bridge.js

### 问题 2：报错 "换权失败 (401)"

**可能原因**：
- 中台未登录或 session 已过期

**解决方案**：
1. 确保中台已登录
2. 检查 localStorage 或 sessionStorage 是否有 token
3. 检查后端 session 配置

### 问题 3：报错 "换权失败 (403)"

**可能原因**：
- /api/extension/session-token 接口需要认证，但拦截器未放行

**解决方案**：
1. 检查 WebConfig 或拦截器配置
2. 确保 /api/extension/** 路径已放行或正确处理认证

### 问题 4：Token 未存储到 Extension Storage

**可能原因**：
- 接口返回格式错误
- storage.local.set 失败

**解决方案**：
1. 检查接口响应格式（应为 `{code: 200, data: {...}}`）
2. 检查 DevTools Console 是否有 storage 错误
3. 检查扩展权限是否包含 "storage"

---

## curl 命令行验证

如果需要独立验证后端接口：

```bash
# 1. 先获取 JWT token（登录）
curl -X POST http://localhost:6017/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"hr001","password":"password123"}'

# 假设返回：{"code":200,"data":{"token":"eyJhbGc..."}}

# 2. 调用 session-token 接口（首次）
curl -X POST http://localhost:6017/api/extension/session-token \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{"token":null}'

# 预期返回：{"code":200,"data":{"token":"xxx","reused":false,"tokenId":"123","expiresAt":"..."}}

# 3. 调用 session-token 接口（复用）
curl -X POST http://localhost:6017/api/extension/session-token \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{"token":"xxx"}'

# 预期返回：{"code":200,"data":{"token":null,"reused":true,"tokenId":"123","expiresAt":"..."}}
```

---

## 验收清单

- [ ] 首次打开中台 → 自动获取 token
- [ ] 重启浏览器 → token 复用
- [ ] 多设备同时使用 → 互不踢出
- [ ] Token 过期 → 自动重新签发
- [ ] 心跳维持 → 每 5 分钟检查一次
- [ ] 后端日志正确记录（新签发 / 复用）
- [ ] Extension Storage 正确存储 token
- [ ] curl 命令行验证通过

---

## 下一步

Phase 1 验证通过后，即可开始 Phase 2：中台触发 + 自动回执。
