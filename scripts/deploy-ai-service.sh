#!/usr/bin/env bash
# ==========================================
#  recruit-ai-service 增量部署（CI 以 gitlab-runner 执行，每次 push main 都跑）
#
#  依据：docs/conventions/ai-service-cd.md
#  一次性 root 前置：scripts/setup-ai-service-host.sh（目录 / venv / unit / sudoers / 密钥文件）
#
#  ★ 本脚本刻意不做的事 ★
#    · 不碰 /etc/systemd/system、不碰密钥文件 —— 那是 root 一次性动作的领地
#    · 不重建 venv —— 每次重建等于把发布时间押在 PyPI 可用性上
#    · 不在失败时"半部署"：任何一步失败即 exit 非 0，旧版继续对外服务
#
#  ★ 为什么把 pytest 放在 restart 之前 ★
#    AI 打分失败是**静默**的（resume_score 落 failed，页面不报错），
#    没有测试闸门的话，一份坏代码会安静地跑上几天。测试是 mock LLM 的、秒级、不联网。
#
#  ★ 为什么校验 api_key_configured ★
#    "服务活着" ≠ "能打分"。缺 key 时 /health 仍返回 200，但每次打分都 502。
#    这跟 db-migrate.sh「记账失败即致命」是同一条原则：机制失效不能伪装成一切正常。
#
#  用法：
#    bash scripts/deploy-ai-service.sh
#    AI_TARGET_DIR=/tmp/probe bash scripts/deploy-ai-service.sh   # 换目标目录（本地试跑）
#
# ⚠️ 中文紧贴变量名必须写成 ${var}：bash 3.2（macOS 自带）会把紧邻的多字节字符
#    误并入变量名，报 `key?: unbound variable`。本文件已全部按 ${var} 书写。
# ==========================================

set -euo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
mark_ok()   { printf '  %s✅%s %s\n' "$GREEN" "$NC" "$1"; }
mark_skip() { printf '  %s⏭️%s %s\n'  "$YELLOW" "$NC" "$1"; }
mark_warn() { printf '  %s⚠️%s %s\n'  "$YELLOW" "$NC" "$1"; }
mark_fail() { printf '  %s❌%s %s\n'  "$RED" "$NC" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC_DIR="$REPO_ROOT/recruit-ai-service"
AI_TARGET="${AI_TARGET_DIR:-/opt/recruit/ai-service}"
AI_UNIT="${AI_UNIT:-recruit-ai.service}"
AI_HEALTH_URL="${AI_HEALTH_URL:-http://127.0.0.1:8000/health}"
VENV_PY="$AI_TARGET/venv/bin/python"
REQ_STAMP="$AI_TARGET/.requirements.sha256"

echo "== recruit-ai-service 部署 =="
echo "   源: ${SRC_DIR}"
echo "   目标: ${AI_TARGET}"
echo

# ---------- 0. 前置检查 ----------
[ -f "$SRC_DIR/main.py" ] || { mark_fail "源码缺失: ${SRC_DIR}/main.py"; exit 1; }
[ -f "$SRC_DIR/requirements.txt" ] || { mark_fail "缺失 requirements.txt"; exit 1; }

if [ ! -d "$AI_TARGET" ]; then
    mark_fail "目标目录不存在: ${AI_TARGET}"
    printf '     先以 root 跑一次：bash scripts/setup-ai-service-host.sh\n' >&2
    exit 1
fi
if [ ! -w "$AI_TARGET" ]; then
    mark_fail "目标目录不可写（当前 $(id -un)）: ${AI_TARGET}"
    exit 1
fi
if [ ! -x "$VENV_PY" ]; then
    mark_fail "venv 不存在: ${VENV_PY}"
    printf '     先以 root 跑一次：bash scripts/setup-ai-service-host.sh\n' >&2
    exit 1
fi
command -v rsync >/dev/null 2>&1 || { mark_fail "缺少 rsync"; exit 1; }
mark_ok "前置检查通过（venv: $("$VENV_PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')）"

# ---------- 1. 同步代码 ----------
# --delete 让目标与仓库严格一致（防残留旧文件），但排除项同时受保护不会被删。
# venv 就在目标目录里，必须在排除列表 —— 否则每次发布都把解释器删掉。
RSYNC_OUT="$(rsync -a --delete --itemize-changes \
    --exclude='.git/' \
    --exclude='venv/' \
    --exclude='__pycache__/' \
    --exclude='*.py[cod]' \
    --exclude='.pytest_cache/' \
    --exclude='.env' \
    --exclude='.env.example' \
    --exclude='.requirements.sha256' \
    "$SRC_DIR/" "$AI_TARGET/")"
CHANGED="$(printf '%s\n' "$RSYNC_OUT" | grep -c '^[<>ch.*][dfL]' || true)"
mark_ok "代码已同步（变更 ${CHANGED} 项）"
if [ "${CHANGED}" = "0" ]; then
    mark_skip "无文件变化 —— 仍会走 restart，保证运行的是仓库当前版本"
fi

# ---------- 2. 依赖（requirements 未变则整段跳过）----------
# sha256sum 在 Linux 有、macOS 没有（只有 shasum -a 256）；部署机是 Linux，
# 但保留 macOS 分支，这样本地也能完整试跑本脚本。
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
    else shasum -a 256 "$1" | awk '{print $1}'; fi
}
NEW_REQ_SHA="$(sha256_of "$SRC_DIR/requirements.txt")"
OLD_REQ_SHA="$( [ -f "$REQ_STAMP" ] && awk '{print $1}' "$REQ_STAMP" || echo '' )"
if [ "$NEW_REQ_SHA" = "$OLD_REQ_SHA" ] && "$VENV_PY" -c 'import uvicorn, fastapi' >/dev/null 2>&1; then
    mark_skip "requirements 未变且依赖可导入，跳过 pip install"
else
    echo "   安装依赖…"
    "$AI_TARGET/venv/bin/pip" install --disable-pip-version-check -q -r "$SRC_DIR/requirements.txt"
    echo "${NEW_REQ_SHA}  $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$REQ_STAMP"
    mark_ok "依赖已安装（sha ${NEW_REQ_SHA:0:12}）"
fi

# ---------- 3. 测试闸门（restart 之前）----------
if [ "${AI_SKIP_TESTS:-0}" = "1" ]; then
    mark_warn "AI_SKIP_TESTS=1 —— 已跳过测试闸门（仅应急用，别成为常态）"
else
    ( cd "$AI_TARGET" && "$VENV_PY" -m pytest -q tests ) || {
        mark_fail "单测未通过 —— 已中止，旧版 AI 服务继续运行"
        exit 1
    }
    mark_ok "单测通过"
fi

# ---------- 4. 重启 ----------
sudo -n /usr/bin/systemctl restart "$AI_UNIT"
mark_ok "已重启 ${AI_UNIT}"

# ---------- 5. 健康检查（含 api_key_configured 断言）----------
# 启动到可服务通常 1–3s；给 30s 上限，超出即失败。
DEADLINE=$(( $(date +%s) + 30 ))
LAST_BODY=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    # --noproxy '*' 是必须的：runner 环境若设了 http_proxy，回环地址也会被送去代理，
    # 探测拿到的是代理的 502 而不是服务真实状态 —— 那会让健康检查产生假阴性。
    if LAST_BODY="$(curl -sf --noproxy '*' --max-time 5 "$AI_HEALTH_URL" 2>/dev/null)"; then
        VERDICT="$(printf '%s' "$LAST_BODY" | "$VENV_PY" -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("bad-json"); raise SystemExit(0)
print("ok" if d.get("status") == "ok" and d.get("api_key_configured") is True
      else ("no-key" if d.get("status") == "ok" else "unhealthy"))
')"
        case "$VERDICT" in
            ok) mark_ok "健康检查通过: ${LAST_BODY}"; break ;;
            no-key)
                mark_fail "服务已起但 LLM_API_KEY 未配置：${LAST_BODY}"
                printf '     打分会全量 502 落 failed。检查 /etc/recruit/ai-service.env（root 600）\n' >&2
                exit 1 ;;
            unhealthy) : ;;  # 还在启动中，继续等
            *) mark_fail "健康响应无法解析：${LAST_BODY}"; exit 1 ;;
        esac
    fi
    sleep 2
done

if [ -z "$LAST_BODY" ]; then
    mark_fail "30s 内 ${AI_HEALTH_URL} 未响应"
    printf '     看日志：sudo journalctl -u %s -n 100 --no-pager\n' "$AI_UNIT" >&2
    exit 1
fi
if [ "$VERDICT" != "ok" ]; then
    mark_fail "健康检查未通过：${LAST_BODY}"
    exit 1
fi

mark_ok "recruit-ai-service 部署完成"
