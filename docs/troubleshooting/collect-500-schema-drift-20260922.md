# 事故复盘：简历采集提交恒定 500「系统繁忙，请稍后重试」（2026-09-22）

> 影响：远端部署机 `118.145.246.201` 上**简历采集 100% 失效**（任何候选人、任何场景）。
> 填充/发布链路不受影响。修复用时约 15 分钟（定位 + ALTER + 复跑验证）。

## 1. 症状与文案溯源

HR 点击「采集到人才库」后浮层提示：

```
采集未完成
系统繁忙，请稍后重试
```

这两行**都不是扩展的业务判断**，逐层对上是：

| 文案片段 | 来源 |
|---|---|
| `采集未完成` | `extension/content/collect-button.js` 自己拼的前缀 |
| `系统繁忙，请稍后重试` | 后端 `GlobalExceptionHandler` 兜底分支（`code=500`），扩展原样转显示 |

**教训 1**：看到「系统繁忙」应直接判定为「后端抛了未捕获异常」，不要去查扩展、CORS、网络。
扩展只是把后端 `msg` 透传出来（`background.js`: `error: submitData.msg`）。

## 2. 定位过程（可复用的排除顺序）

| 步骤 | 手段 | 结论 |
|---|---|---|
| 1 | 用扩展真实 token 打 `POST /api/ext/collect/resumes`（最小合法 payload、纯 ASCII、无附件） | **100% 回 500** → 与候选人/数据内容无关 |
| 2 | 远端 `OPTIONS` 预检探 `/api/ext/drafts` | 200 + `Access-Control-Allow-Origin` → CORS 已修好、后端版本是新的 |
| 3 | **本地同代码 + 同 payload** 打 `localhost:6017` | **200 成功** → 代码没问题，差异在远端环境 |
| 4 | `journalctl -u recruit-server` 抓堆栈 | 一句话钉死根因（见下） |

第 3 步是这类「线上 500 但代码看着没错」的分水岭：本地能跑通就把战场从代码挪到环境。

## 3. 根因

```
java.sql.SQLSyntaxErrorException: Unknown column 'platform_user_id_alt' in 'field list'
### SQL: SELECT id,platform,platform_user_id,platform_user_id_alt,... FROM candidate
           WHERE (platform = ? AND (platform_user_id IN (?) OR platform_user_id_alt IN (?)))
  at com.recruit.service.CollectService.collectOne(CollectService.java:132)
```

远端库 `candidate` 表**缺 `platform_user_id_alt` 列**（连带缺 `idx_platform_user_alt` 索引）。
采集入库的第一步就是按「双 ID 空间」查候选人，直接撞在缺列上。

**为什么会漂**：

| 时间 | 事件 |
|---|---|
| 09-21 11:22–15:09 | 在服务器上 rsync SQL 并执行 DDL → 采集四表建好 |
| 09-21 16:17 | 「备用 ID 加列」方案才落地（`candidate_alter_add_alt_*` + `candidate_create` 同步补列） |
| — | **这批改动从未同步到服务器**（服务器 `/root/recruit-sql/` 的文件时间戳可证） |

且 `CREATE TABLE IF NOT EXISTS` 对**已存在的表是空操作** —— 重跑 `db-bootstrap.sh` 也补不上列。
**唯一能收敛的是那条 ALTER 脚本。**

**教训 2**：`CREATE TABLE IF NOT EXISTS` 会让「结构变更」在存量库上静默失效。
`create` 脚本改了 ≠ 存量库改了，**必须有配套的 `alter` 且必须真的执行**。

**教训 3**：不能用读接口反证写路径的列齐全。本次我曾用 `GET /api/candidates` 返回 200
推断「该列存在」—— 错，因为中台列表查询走的是 VO 的列子集，没覆盖这一列。
验证列齐全要直接查 `information_schema`。

## 4. 修复

```
mysql -uroot recruit_platform < candidate_alter_add_alt_platform_user_id_20260921_V1.sql
```

脚本本身是幂等 + 自校验的（`information_schema` 判表/列/索引存在性 → `PREPARE/EXECUTE`，
末尾打印 `col_ok / idx_ok`）。执行时 `candidate` 表 0 行，ALTER 瞬时完成。

## 5. 验证（全部通过）

| 验证项 | 结果 |
|---|---|
| `POST /api/ext/collect/resumes`（修复前 100% 500） | ✅ 200，`candidateCreated=true, resumeVersionCreated=true` |
| 中台候选人库读回 | ✅ `total=1`，姓名 / ID / versionCount 正常 |
| 新列真的承载备用 ID | ✅ `platform_user_id=AIPROBE_VERIFY_1` + `platform_user_id_alt=608120464` |
| 迁移脚本幂等复跑 | ✅ 三步全报「已存在，跳过」，零改动 |
| 远端 vs 本地（已知良好）全量 schema diff | ✅ **241 vs 241 行，0 差异**（排除本地独有的 `_legacy_*` 旧表） |

## 6. 制度缺口（建议后续处理）

**`.gitlab-ci.yml` 只构建 + 部署 jar/dist，不执行任何 SQL 迁移。**
→ 任何 DDL 都退化成「隐形人工步骤」，本次事故就是它漏掉的一步。

建议二选一（按投入排序）：

1. **加一道漂移门禁**：CI 里对部署机库跑一次 `information_schema` 与 `sql/*.sql` 的比对，
   有差异就让 job 标红（不自动执行 DDL，避免误动存量数据）。
2. **迁移纳入发布流程**：把 `sql/*.sql`（幂等）作为部署步骤的一部分执行，
   `sql/upgrade/*.sql`（一次性）仍人工确认后执行并登记。

配套：部署后自检清单里补一条「`SHOW COLUMNS` 关键表列数与 create 脚本一致」。

## 7. 复现/自检命令

```bash
# 服务端日志里的真根因（先看这个，别猜）
journalctl -u recruit-server --since "30 min ago" | grep -A30 "未捕获异常"

# 采集四表的列数核对（远端 vs create 脚本）
mysql -uroot -N -B recruit_platform -e "
SELECT table_name, COUNT(*) FROM information_schema.columns
WHERE table_schema='recruit_platform'
  AND table_name IN ('candidate','resume_version','attachment','collect_audit')
GROUP BY table_name;"

# 结构漂移对比（把远端与本地/新库逐列 diff，排除 _legacy_*）
#   见本文 §5：远端 241 行 == 本地 241 行 即为零漂移
```
