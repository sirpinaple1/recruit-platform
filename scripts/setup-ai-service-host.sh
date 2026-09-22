#!/usr/bin/env bash
# ==========================================
#  recruit-ai-service 部署机一次性初始化（root 执行）
#
#  用途：把「CI 做不到、也不需要每次做」的 root 动作在这里做完一次，
#        之后 scripts/deploy-ai-service.sh（gitlab-runner）就能纯增量部署。
#
#  为什么需要分开两个脚本：
#    CI 以 gitlab-runner 运行，写不了 /etc/systemd/system、建不了 600 的密钥文件、
#    也做不了 chown。硬塞进 CI 意味着要么给 runner 开 root、要么把密钥放成 runner 可读 ——
#    两条都比「一次性人工初始化」差。对照 docs/conventions/db-migration-cd.md §6 的
#    最小权限思路：runner 只拿到**它每次都必须做的事**所需的最小权限（见 deploy/sudoers/）。
#
#  用法（部署机 118.145.246.201，root）：
#    bash scripts/setup-ai-service-host.sh
#
#  幂等：可重复执行。venv / 目录 / unit / sudoers 都是「缺失才建、存在就复用或覆盖」。
#
#  依据文档：docs/conventions/ai-service-cd.md
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

AI_TARGET="${AI_TARGET_DIR:-/opt/recruit/ai-service}"
AI_USER="${AI_USER:-gitlab-runner}"
AI_ENV_FILE="${AI_ENV_FILE:-/etc/recruit/ai-service.env}"
SRC_DIR="$REPO_ROOT/recruit-ai-service"

echo "== recruit-ai-service 部署机初始化 =="
echo "   仓库: ${REPO_ROOT}"
echo "   目标: ${AI_TARGET}"
echo

# ---------- 0. 身份检查 ----------
if [ "$(id -u)" -ne 0 ]; then
    mark_fail "必须以 root 执行（当前 $(id -un)）。sudo -i 后重跑本脚本。"
    exit 1
fi
mark_ok "身份: root"

# ---------- 1. 源码目录 ----------
if [ ! -f "$SRC_DIR/requirements.txt" ] || [ ! -f "$SRC_DIR/main.py" ]; then
    mark_fail "源码不完整：${SRC_DIR} 下应同时有 main.py 与 requirements.txt"
    exit 1
fi
mark_ok "源码: ${SRC_DIR}"

# ---------- 2. Python 版本 ----------
# 代码用了 `str | None` 注解，运行时求值要求 3.10+（3.9 会 TypeError）。
PY_BIN="${PY_BIN:-}"
if [ -z "$PY_BIN" ]; then
    for c in python3 python3.11 python3.12 python3.10; do
        if command -v "$c" >/dev/null 2>&1; then PY_BIN="$(command -v "$c")"; break; fi
    done
fi
if [ -z "$PY_BIN" ]; then
    mark_fail "未找到 python3。先装：apt-get install -y python3 python3-venv python3-pip"
    exit 1
fi
PY_VER="$("$PY_BIN" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
PY_MAJOR="${PY_VER%%.*}"; PY_MINOR="${PY_VER##*.}"
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    mark_fail "Python ${PY_VER} 版本过低，需要 >= 3.10（代码用了 PEP 604 的 str | None 注解）"
    exit 1
fi
mark_ok "Python: ${PY_BIN} (${PY_VER})"

# ---------- 3. 用户与目录 ----------
if ! id "$AI_USER" >/dev/null 2>&1; then
    mark_fail "用户 ${AI_USER} 不存在。CI 就是用它跑的，先确认 runner 装好了。"
    exit 1
fi
mkdir -p "$AI_TARGET"
mark_ok "目录: ${AI_TARGET}"

# ---------- 4. venv ----------
VENV_PY="$AI_TARGET/venv/bin/python"
if [ -x "$VENV_PY" ]; then
    mark_skip "venv 已存在，复用（$( "$VENV_PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' )）"
else
    echo "   创建 venv（首次需要联网装 ensurepip）…"
    "$PY_BIN" -m venv "$AI_TARGET/venv"
    mark_ok "venv 已创建"
fi

# 依赖装上，让 CI 首次部署时即使无网也能起服务（CI 仍会在 requirements 变更时重装）
echo "   预装依赖 requirements.txt …"
"$AI_TARGET/venv/bin/pip" install --disable-pip-version-check -q -r "$SRC_DIR/requirements.txt"
mark_ok "依赖已就位"

# ---------- 5. 密钥文件（root 600，runner 读不到也不需要读）----------
mkdir -p "$(dirname "$AI_ENV_FILE")"
if [ -f "$AI_ENV_FILE" ]; then
    mark_skip "密钥文件已存在，不覆盖：${AI_ENV_FILE}"
else
    cat > "$AI_ENV_FILE" <<'EOF'
# recruit-ai-service 运行时环境变量（由 systemd 以 root 读取，部署用户无需可读）
# 复制自 recruit-ai-service/.env.example，填好后 chmod 600。

LLM_API_KEY=
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_TIMEOUT_SECONDS=60
EOF
    chmod 600 "$AI_ENV_FILE"; chown root:root "$AI_ENV_FILE"
    mark_warn "已生成空模板 ${AI_ENV_FILE}（600），LLM_API_KEY 还空着 —— 见下方收尾步骤"
fi
chmod 600 "$AI_ENV_FILE" 2>/dev/null || true
chown root:root "$AI_ENV_FILE" 2>/dev/null || true

# ---------- 6. systemd unit ----------
UNIT_SRC="$REPO_ROOT/deploy/recruit-ai.service"
UNIT_DST="/etc/systemd/system/recruit-ai.service"
if [ -f "$UNIT_DST" ] && cmp -s "$UNIT_SRC" "$UNIT_DST"; then
    mark_skip "unit 未变化: ${UNIT_DST}"
else
    install -m 644 -o root -g root "$UNIT_SRC" "$UNIT_DST"
    mark_ok "unit 已安装: ${UNIT_DST}"
fi
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable recruit-ai.service >/dev/null 2>&1 || true
mark_ok "daemon-reload + enable 完成"

# ---------- 7. sudoers 白名单（CI 用它 restart）----------
SUDO_SRC="$REPO_ROOT/deploy/sudoers/gitlab-runner-recruit-ai"
SUDO_DST="/etc/sudoers.d/gitlab-runner-recruit-ai"
if [ -f "$SUDO_DST" ] && cmp -s "$SUDO_SRC" "$SUDO_DST"; then
    mark_skip "sudoers 未变化: ${SUDO_DST}"
else
    install -m 440 -o root -g root "$SUDO_SRC" "$SUDO_DST"
    if /usr/sbin/visudo -cf "$SUDO_DST" >/dev/null 2>&1; then
        mark_ok "sudoers 已安装并通过语法校验: ${SUDO_DST}"
    else
        mark_fail "sudoers 语法校验失败，已回滚该文件，避免锁死 sudo"
        rm -f "$SUDO_DST"
        exit 1
    fi
fi

# ---------- 8. 归属 ----------
chown -R "$AI_USER":"$AI_USER" "$AI_TARGET"
mark_ok "归属已设为 ${AI_USER}: ${AI_TARGET}"

# ---------- 9. 收尾提示 ----------
echo
if ! grep -q '^LLM_API_KEY=[[:space:]]*[^[:space:]]' "$AI_ENV_FILE"; then
    mark_fail "LLM_API_KEY 仍是空的 —— 不填就启动，所有打分都会 502 落 failed（服务表面却是活的）"
    echo
    echo "   下一步（root）："
    echo "     vi ${AI_ENV_FILE}          # 填上 LLM_API_KEY=sk-…"
    echo "     chmod 600 ${AI_ENV_FILE}; chown root:root ${AI_ENV_FILE}"
    echo "     systemctl start recruit-ai.service"
    echo "     curl -s http://127.0.0.1:8000/health   # 应见 api_key_configured: true"
    echo
    exit 1
fi
mark_ok "LLM_API_KEY 已配置"

echo "   启动：systemctl start recruit-ai.service"
echo "   自检：curl -s http://127.0.0.1:8000/health"
echo
mark_ok "初始化完成。之后每次 push main，CI 会自动跑 scripts/deploy-ai-service.sh。"
