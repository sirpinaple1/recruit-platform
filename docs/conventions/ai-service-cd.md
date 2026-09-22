# recruit-ai-service 部署约定（CD）

> 范围：`recruit-ai-service`（Python / FastAPI，简历打分）如何上到部署机 `118.145.246.201`。
> 与 `docs/conventions/db-migration-cd.md` 同一套思路：**最小权限 + 失败即停 + 不静默降级**。

---

## 1. 背景：为什么要补这一步

2026-09-22 生产验证时发现：CI 只部署了后端与前端，`recruit-ai-service` **从未被部署过**。
后果是静默的——

| 现象 | 实际原因 |
|---|---|
| `/api/health` 200、后端一切正常 | AI 服务根本不在，健康检查里也不含它 |
| 简历打分全落 `failed` | `AiServiceClient` 调 `127.0.0.1:8000` 连接被拒 → 抛 `MyException(502)` |
| 页面无报错 | 打分走 `resumeScoreExecutor` 异步线程，失败只写状态列 |

**教训**：一个"不阻塞主流程"的下游服务，缺了也不会让流水线变红 —— 这正是必须把它
纳入 CI 并把断言写进健康检查的原因。

---

## 2. 部署拓扑

```
recruit-server (6017)  ──HTTP──▶  recruit-ai-service (127.0.0.1:8000，仅回环)
                                   └─▶ LLM 供应商（DeepSeek / 智谱，出公网）

/opt/recruit/ai-service/            # 代码 + venv，属主 gitlab-runner
/etc/recruit/ai-service.env         # LLM_API_KEY，root:root 600
/etc/systemd/system/recruit-ai.service
```

`ai.service.url` 在 `application-prod.yml` 里默认 `${AI_SERVICE_URL:http://127.0.0.1:8000}`，
即后端与 AI 同机；跨机时给 `AI_SERVICE_URL` 即可，代码不动。

---

## 3. 一次性 root 初始化（新机器 / 首次启用时做）

```bash
# 部署机，root
bash scripts/setup-ai-service-host.sh
```

它做这些 CI 做不到也不该每次做的事：

| 动作 | 为什么不能放进 CI |
|---|---|
| 建 `/opt/recruit/ai-service` + venv + 预装依赖 | 每次重建 venv 等于把发布时间押在 PyPI 可用性上 |
| 生成 `/etc/recruit/ai-service.env`（600 root:root） | runner 不该读到 LLM Key |
| 安装 `deploy/recruit-ai.service` 到 `/etc/systemd/system` | 需要 root 写 |
| 安装 `deploy/sudoers/gitlab-runner-recruit-ai`（0440） | 需要 root 写；只点名放行 restart/start/status |
| `chown -R gitlab-runner` | 需要 root |

收尾必须做：把 `LLM_API_KEY` 填进 `/etc/recruit/ai-service.env`。
脚本在 key 仍为空时**以非 0 退出**并打印后续命令——带着空 key 起服务更糟：
表面活着，打分全 502。

---

## 4. CI 每次发布做的事

`.gitlab-ci.yml` 的 `deploy` job 里，顺序是：

```
mvn 打包 → npm build → DDL 迁移 → 替换 jar + restart 后端
        → bash scripts/deploy-ai-service.sh → rsync dist → 健康检查(6017 + 8000)
```

**AI 放在后端之后是刻意的**：一份坏掉的 AI 代码不该拦住后端的热修发布。
但 AI 失败同样让 job 标红，不会静默过去。

脚本内部四步，各自都是闸门：

1. **rsync** `--delete`（排除 `venv/`、`.env`、`__pycache__`、`.pytest_cache/`）——
   目标与仓库严格一致，防旧文件残留；`venv` 就在目标目录里，必须在排除列表，
   否则每次发布都把解释器删掉。
2. **pip install** —— `requirements.txt` 的 sha256 未变且依赖可导入则整段跳过，
   避免每次发布都联网。
3. **pytest**（restart 之前）—— 打分失败是静默的，没有闸门的话坏代码会安静跑几天。
   测试是 mock LLM 的、秒级、不联网。
4. **restart + 健康检查** —— 不仅看 200，还断言 `/health` 返回的
   `api_key_configured == true`。**"服务活着" ≠ "能打分"**，
   这与 db-migrate.sh「记账失败即致命」是同一条原则：机制失效不能伪装成一切正常。
   探测一律带 `curl --noproxy '*'`：runner 环境若设了 `http_proxy`，
   回环地址也会被送去代理，拿到的是代理的 502 而非服务真实状态（假阴性）。

---

## 5. 密钥：为什么用 systemd EnvironmentFile 而不是部署目录下的 .env

`pydantic-settings` 支持从 cwd 的 `.env` 读，但那会把密钥复制到一个
gitlab-runner 可读可写的目录里。改用：

```ini
[Service]
EnvironmentFile=/etc/recruit/ai-service.env
```

systemd 以 root 读该文件并注入进程环境，之后才降权到 `gitlab-runner` 启动 uvicorn。
于是 runner **不需要读、也读不到** Key —— 比 `docs/conventions/db-migration-cd.md §6`
那份给 runner 读的 `migrate.env`（640）还严一档。那份之所以要 640，是因为
`mysql` 客户端本身就是 runner 进程；这里没有这个必要。

`EnvironmentFile` 不加前导 `-`（缺失即启动失败）同样是刻意的 fail-fast。

验证方式只有一条安全路径：

```bash
curl -s http://127.0.0.1:8000/health
# {"status":"ok","model":"deepseek-chat","api_key_configured":true}
# ↑ 只回布尔值，不回传内容
```

---

## 6. 常用运维命令

```bash
sudo systemctl status recruit-ai
sudo journalctl -u recruit-ai -f
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/docs          # 仅回环可达
```

手动重跑一次部署（不改代码也要重起时）：

```bash
sudo -u gitlab-runner bash scripts/deploy-ai-service.sh
```

应急跳过测试闸门（**不要成为常态**，写了会在日志里打 ⚠️）：

```bash
AI_SKIP_TESTS=1 bash scripts/deploy-ai-service.sh
```

---

## 7. 已知取舍

- `pytest` 目前列在 `requirements.txt` 里，会装进生产 venv。好处是测试闸门可以复用
  生产解释器、零额外基础设施；代价是生产镜像多几个测试包。将来若要收紧，
  拆成 `requirements-dev.txt` 并为闸门单独建 venv。
- 单进程 uvicorn（`--host 127.0.0.1`）。并发由 `recruit-server` 侧的
  `resumeScoreExecutor` 线程池控制，LLM 侧慢就排队，不在 AI 服务里做限流。
- 未做回滚：AI 服务无状态，回滚即 `git revert` 后重跑流水线。
