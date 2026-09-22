#!/usr/bin/env bash
# ==========================================
# 收敛式 DDL 迁移执行器（scripts/db-migrate.sh）
#
# 依据：docs/conventions/db-migration-cd.md
# 事故来源：docs/troubleshooting/collect-500-schema-drift-20260922.md
#
# ★ 语义（与 Flyway 相反，先读这段）★
#   本仓库 sql/*.sql 是**幂等收敛脚本**：CREATE TABLE IF NOT EXISTS；
#   ALTER 用 information_schema 守卫自跳；注释靠「比较后不一致才 MODIFY」收敛。
#   所以「重复执行」是安全的 —— 本脚本据此做「**内容变了就重跑**」的收敛，
#   而不是 Flyway 的「版本推进 + 脚本不可变 + checksum 校验报错」。
#   需要版本语义时再迁 Flyway，届时 schema_migration 表可直接当 baseline 依据。
#
# ★ 硬约束（每条都有实现，别删）★
#   1. 必须在 `systemctl restart` **之前**跑。迁移与代码不匹配就是事故本体；
#      失败 exit 非 0 → CI job 失败 → 走不到 restart → 旧版继续对外服务。
#   2. 迁移前自动做**结构快照**（mysqldump --no-data），按份数滚动清理。
#      只备结构不备数据 —— 数据级回滚不在本脚本职责内（见文档「回滚」节）。
#   3. `flock` 串行化：防 pipeline retry / 手工重跑并发。
#      （不用 MySQL GET_LOCK：命令行客户端每次调用都是新连接，锁拿不住。）
#   4. `sql/upgrade/` 默认**不跑**，需 RUN_UPGRADE=1 —— 一次性迁移走人工闸门。
#   5. 破坏性 DDL（DROP / TRUNCATE / ADD UNIQUE）需 ALLOW_DESTRUCTIVE=1，否则失败停下等人确认。
#
# 用法：
#   bash scripts/db-migrate.sh                 # 正常执行
#   DRY_RUN=1 bash scripts/db-migrate.sh       # 只列出会发生什么，不写任何东西
#   RUN_UPGRADE=1 bash scripts/db-migrate.sh   # 同时执行 sql/upgrade/
#   ALLOW_DESTRUCTIVE_SCRIPTS=publish_record_alter_add_platform_job_id_20260922_V1.sql \
#       bash scripts/db-migrate.sh             # 点名放行某个已审过的破坏性脚本
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

# ---------- 连库参数：优先读部署机的 systemd EnvironmentFile ----------
# 必须在读取下面任何配置**之前**加载，否则 MIGRATE_* 覆盖项无法从 env 文件生效。
ENV_FILE="${MIGRATE_ENV_FILE:-/etc/recruit/recruit-server.env}"
if [ -f "$ENV_FILE" ] && [ ! -r "$ENV_FILE" ]; then
    # 这是 CI 上最常见的一种「连不上库」：文件在、但当前用户读不到。
    # 部署机上该文件是 root:root 600，而 CI 以 gitlab-runner 跑 —— 必须显式提示，
    # 否则只会得到一句误导性的「检查 MYSQL_URL / 账号密码」。
    printf '⚠️  环境文件存在但当前用户（%s）读不到：%s\n' "$(id -un)" "$ENV_FILE" >&2
    printf '    处理：让 runner 可读（chgrp + chmod 640），或用 MIGRATE_ENV_FILE 指向一份\n' >&2
    printf '    仅含 MIGRATE_DB_* 的最小权限凭据文件。见 docs/conventions/db-migration-cd.md「权限前置」。\n' >&2
fi
if [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

# ---------- 路径与开关（env 文件加载后再读，允许被其覆盖）----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SQL_DIR="${MIGRATE_SQL_DIR:-$REPO_ROOT/recruit-server/sql}"
BACKUP_DIR="${MIGRATE_BACKUP_DIR:-/opt/recruit/backup}"
KEEP_BACKUPS="${MIGRATE_KEEP_BACKUPS:-20}"
LOCK_FILE="${MIGRATE_LOCK_FILE:-/tmp/recruit-db-migrate.lock}"
DRY_RUN="${DRY_RUN:-0}"
RUN_UPGRADE="${RUN_UPGRADE:-0}"
ALLOW_DESTRUCTIVE="${ALLOW_DESTRUCTIVE:-0}"
# 逐脚本放行名单（逗号分隔的台账键，如 sql/ 下就是文件名；seed/upgrade 需带目录前缀）。
#
# ★ 为什么要有这个、而不用 ALLOW_DESTRUCTIVE=1 ★
#   闸门本意是「破坏性语句停下来等人确认」。但有一类脚本**本身是安全的**：
#   带 information_schema 守卫的 ALTER（索引/列已存在就自动跳过），
#   它只在老库上第一次跑时才动手，之后永远自跳。对这类脚本每次都拦，
#   结果就是把 ALLOW_DESTRUCTIVE=1 变成每次发布的常备项 —— 闸门随即名存实亡
#   （脚本头注释第 5 条已明确反对这种做法）。
#   所以改成**点名放行**：闸门对其它脚本照常生效，只对审过的脚本让路，
#   且放行时仍打 ⚠️ 让 reviewers 看见。
ALLOW_DESTRUCTIVE_SCRIPTS="${ALLOW_DESTRUCTIVE_SCRIPTS:-}"

parse_jdbc() {
    # jdbc:mysql://HOST[:PORT]/DB[?params] -> "HOST PORT DB"
    local u="${1#jdbc:mysql://}" host port db
    u="${u%%\?*}"
    host="${u%%/*}"
    db="${u#*/}"
    if [ "$host" != "${host%%:*}" ]; then
        port="${host##*:}"
        host="${host%%:*}"
    else
        port=3306
    fi
    printf '%s %s %s\n' "$host" "$port" "$db"
}

DB_HOST="${MIGRATE_DB_HOST:-}"
DB_PORT="${MIGRATE_DB_PORT:-}"
DB_NAME="${MIGRATE_DB_NAME:-}"
if [ -z "${DB_HOST}${DB_PORT}${DB_NAME}" ] && [ -n "${MYSQL_URL:-}" ]; then
    read -r DB_HOST DB_PORT DB_NAME <<<"$(parse_jdbc "$MYSQL_URL")"
fi
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-recruit_platform}"
DB_USER="${MIGRATE_DB_USER:-${MYSQL_USERNAME:-root}}"
DB_PASS="${MIGRATE_DB_PASSWORD:-${MYSQL_PASSWORD:-}}"

MYSQL_ARGS=(--default-character-set=utf8mb4)
if [ -n "${MIGRATE_DB_SOCKET:-}" ]; then
    MYSQL_ARGS+=(--socket="$MIGRATE_DB_SOCKET")
else
    MYSQL_ARGS+=(--protocol=TCP -h "$DB_HOST" -P "$DB_PORT")
fi
MYSQL_ARGS+=(-u "$DB_USER")
if [ -n "$DB_PASS" ]; then
    # 用 MYSQL_PWD 而不是 -p"$pass"：后者会让客户端每次都在 stderr 打
    # 「Using a password on the command line interface can be insecure」，
    # 既刷屏 CI 日志，又会混进下面捕获的错误摘要里。
    export MYSQL_PWD="$DB_PASS"
fi

q() { mysql "${MYSQL_ARGS[@]}" -N -B "$DB_NAME" -e "$1"; }
run_file() { mysql "${MYSQL_ARGS[@]}" "$DB_NAME"; }

# ---------- 跨平台小工具（本脚本既要在 Linux 部署机跑，也想在 macOS 开发机跑）----------
if command -v sha256sum >/dev/null 2>&1; then
    checksum_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    checksum_of() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v openssl >/dev/null 2>&1; then
    checksum_of() { openssl dgst -sha256 "$1" | awk '{print $NF}'; }
else
    echo "缺少 sha256 工具（sha256sum / shasum / openssl 至少有一个）" >&2
    exit 1
fi

_ms_probe="$(date +%s%3N 2>/dev/null || true)"
if [[ "$_ms_probe" =~ ^[0-9]{13}$ ]]; then
    now_ms() { date +%s%3N; }
else
    # BSD date 不支持 %N，退化到 perl（拿不到就只到秒，不影响判定失败）
    now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000' 2>/dev/null || echo "$(( $(date +%s) * 1000 ))"; }
fi

# ---------- 前置检查 ----------
echo "========================================="
echo "recruit-platform DDL 迁移（收敛式）"
echo "========================================="
echo "目标库: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "真源  : ${SQL_DIR}"
echo "备份  : ${BACKUP_DIR}"
echo "开关  : DRY_RUN=${DRY_RUN} RUN_UPGRADE=${RUN_UPGRADE} ALLOW_DESTRUCTIVE=${ALLOW_DESTRUCTIVE}"
echo ""

for t in mysql mysqldump; do
    if ! command -v "$t" >/dev/null 2>&1; then
        mark_fail "缺少命令：${t}"
        exit 1
    fi
done

if [ ! -d "$SQL_DIR" ]; then
    mark_fail "未找到 SQL 真源目录：${SQL_DIR}"
    exit 1
fi

if ! q "SELECT 1;" >/dev/null 2>&1; then
    mark_fail "连不上数据库（检查 MYSQL_URL / 账号密码 / 网络）"
    exit 1
fi

# ---------- 台账表自举（唯一真源 = sql/schema_migration_create_*.sql）----------
LEDGER_CREATE="$(ls -1 "$SQL_DIR"/schema_migration_create_*.sql 2>/dev/null | sort | tail -1 || true)"
if [ -z "$LEDGER_CREATE" ]; then
    mark_fail "找不到台账建表脚本（${SQL_DIR}/schema_migration_create_*.sql）"
    exit 1
fi
LEDGER_BASENAME="$(basename "$LEDGER_CREATE")"

LEDGER_EXISTS=0
if [ "$(q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='schema_migration';")" = "1" ]; then
    LEDGER_EXISTS=1
fi

if [ "$DRY_RUN" = "1" ]; then
    if [ "$LEDGER_EXISTS" = "1" ]; then
        echo "台账表: 已存在"
    else
        echo "台账表: 尚不存在（首次运行会创建，本次全部视为待执行）"
    fi
    echo ""
else
    run_file <"$LEDGER_CREATE"
    mark_ok "台账表就绪（${LEDGER_BASENAME}）"
    echo ""
fi

# ---------- 串行化 ----------
# 不用 MySQL GET_LOCK：命令行客户端每次调用都是新连接，锁随连接结束即释放，拿不住整段迁移。
# 部署机是单机 shell runner，主机级 flock 足够；将来多机部署再换成
# 「持有一条长连接跑 SELECT GET_LOCK()」或迁移专用的选主机制。
if [ "$DRY_RUN" != "1" ]; then
    if command -v flock >/dev/null 2>&1; then
        exec 9>"$LOCK_FILE"
        if ! flock -n 9; then
            mark_fail "另一个迁移进程正在运行（锁：${LOCK_FILE}）"
            exit 1
        fi
    else
        mark_warn "本机没有 flock，跳过并发保护（macOS 开发机正常；部署机应有）"
    fi
fi

# ---------- 结构快照（仅结构，滚动保留）----------
if [ "$DRY_RUN" != "1" ]; then
    mkdir -p "$BACKUP_DIR"
    SNAPSHOT="${BACKUP_DIR}/schema-$(date +%Y%m%d-%H%M%S).sql"
    if mysqldump "${MYSQL_ARGS[@]}" --no-data --skip-comments --single-transaction "$DB_NAME" >"$SNAPSHOT" 2>/dev/null; then
        mark_ok "结构快照 $(basename "$SNAPSHOT")"
    else
        mark_fail "结构快照失败（${SNAPSHOT}）—— 不继续执行 DDL"
        exit 1
    fi
    # 滚动清理旧快照（不用 xargs -r：BSD xargs 没有该选项）
    PRUNE_LIST="$(ls -1t "$BACKUP_DIR"/schema-*.sql 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" || true)"
    for old in $PRUNE_LIST; do
        rm -f "$old"
    done
    echo ""
fi

# ---------- 破坏性 DDL 闸门 ----------
# 判据是「**数据不可逆丢失**」，不是「语句听起来可怕」：
#   拦：DROP TABLE / DROP COLUMN / DROP DATABASE / TRUNCATE TABLE / ADD UNIQUE / ADD CONSTRAINT
#       —— 前四个丢数据且不可回滚；后两个会改变约束语义、可能让既有数据不满足而失败。
#   不拦：DROP INDEX —— 索引可从列定义重建（删错最多掉性能，不丢数据）。
#         本仓库的 sys_user_drop_redundant_idx_* 就是这类合法清理，逐次拦它会让
#         ALLOW_DESTRUCTIVE=1 变成每次发布的常备项，闸门随即失效。
# MODIFY COLUMN 单独作为**非阻断汇总告警**：本仓库的「注释收敛」段合法使用它，
#   但它同时能收窄类型 —— 让眼睛看到，而不是让脚本猜意图。
DESTRUCTIVE_RE='DROP[[:space:]]+(TABLE|COLUMN|DATABASE)|TRUNCATE[[:space:]]+TABLE|ADD[[:space:]]+(UNIQUE|CONSTRAINT)'
NARROWING_RE='MODIFY[[:space:]]+COLUMN'

# ---------- 逐个执行 ----------
APPLIED=0; SKIPPED=0; FAILED=0; BLOCKED=0
FAILED_SCRIPT=""
NARROW_SCRIPTS=""

ledger_checksum() {
    if [ "$LEDGER_EXISTS" != "1" ]; then
        printf ''
        return 0
    fi
    q "SELECT checksum FROM schema_migration WHERE script='$1';"
}

# 该脚本是否在「逐脚本放行名单」里。
# 匹配用「两端补逗号」的整段包含，避免 publish_x 命中 publish_xyz 这类前缀误放行。
destructive_allowed() {
    local key="$1" base list
    [ -n "$ALLOW_DESTRUCTIVE_SCRIPTS" ] || return 1
    list=",${ALLOW_DESTRUCTIVE_SCRIPTS},"
    base="$(basename "$key")"
    if [ "${list#*,$key,}" != "$list" ] || [ "${list#*,$base,}" != "$list" ]; then
        return 0
    fi
    return 1
}

apply_one() {
    # $1 = 台账键（相对路径）  $2 = 绝对路径
    local key="$1" path="$2" sum before after ms err summary ledger_out
    sum="$(checksum_of "$path")"

    if [ "$(ledger_checksum "$key")" = "$sum" ]; then
        mark_skip "${key}（内容未变，跳过）"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    if grep -Eq "$DESTRUCTIVE_RE" "$path" && [ "$ALLOW_DESTRUCTIVE" != "1" ]; then
        if destructive_allowed "$key"; then
            mark_warn "${key} 含破坏性语句，但在放行名单中（已人工审查：带守卫，幂等）"
        else
            mark_fail "${key} 含破坏性语句（DROP/TRUNCATE/ADD UNIQUE），"
            printf '      → 需 ALLOW_DESTRUCTIVE=1，或把该脚本加入 ALLOW_DESTRUCTIVE_SCRIPTS（逐脚本放行）\n'
            BLOCKED=$((BLOCKED + 1))
            return 1
        fi
    fi
    # MODIFY COLUMN 非阻断，但**汇总**提示而不是逐条刷屏：
    # 本仓库的「注释收敛」段合法使用它，逐条告警会训练人忽略。
    # 只在「确实要执行这个脚本」时才记，跳过的脚本与本次无关。
    if grep -Eq "$NARROWING_RE" "$path"; then
        NARROW_SCRIPTS="${NARROW_SCRIPTS} ${key}"
    fi

    if [ "$DRY_RUN" = "1" ]; then
        mark_ok "${key}（DRY_RUN：将会执行）"
        APPLIED=$((APPLIED + 1))
        return 0
    fi

    before="$(now_ms)"
    if err="$(run_file <"$path" 2>&1)"; then
        after="$(now_ms)"; ms=$((after - before))
        # ★ 记账失败必须致命（fail-closed）★
        # 记账写不进去时，跳过机制会静默退化成「每次都全量重跑」，且审计线索丢失 ——
        # 这正是本项目一路在消灭的「静默漂移」。实测踩过：DDL 账号缺 UPDATE 权限时
        # ON DUPLICATE KEY UPDATE 会报 1142，而当时这里是裸调用，错误被吞、退出码仍为 0。
        if ! ledger_out="$(q "INSERT INTO schema_migration (script,checksum,status,duration_ms,error,applied_at)
           VALUES ('$key','$sum','applied',$ms,NULL,UTC_TIMESTAMP(3))
           ON DUPLICATE KEY UPDATE checksum=VALUES(checksum),status='applied',
             duration_ms=VALUES(duration_ms),error=NULL,applied_at=UTC_TIMESTAMP(3);" 2>&1)"; then
            mark_fail "台账写入失败（脚本已执行但无法记账，跳过机制将失效）：${ledger_out}"
            exit 1
        fi
        mark_ok "${key}（${ms}ms）"
        APPLIED=$((APPLIED + 1))
        return 0
    fi

    after="$(now_ms)"; ms=$((after - before))
    # 错误摘要：剥掉单引号与换行，避免拼 SQL 时被注入/截断
    summary="$(printf '%s' "$err" | tr -d "'" | tr '\n' ' ' | cut -c1-500)"
    if ! q "INSERT INTO schema_migration (script,checksum,status,duration_ms,error,applied_at)
       VALUES ('$key','$sum','failed',$ms,'$summary',UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE checksum=VALUES(checksum),status='failed',
         duration_ms=VALUES(duration_ms),error=VALUES(error),applied_at=UTC_TIMESTAMP(3);" 2>/dev/null; then
        mark_warn "台账写入失败（本次失败记录未能入账）"
    fi
    mark_fail "${key}（${ms}ms）"
    printf '%s\n' "$err" | sed 's/^/      /' | head -20
    FAILED=$((FAILED + 1))
    return 1
}

# ---- 0) 台账建表脚本本身（先执行一次，保证它被登记）----
apply_one "$LEDGER_BASENAME" "$LEDGER_CREATE" || true

# ---- 1) DDL（sql/*.sql，字典序，与 db-bootstrap.sh 同口径）----
echo "1) DDL（sql/*.sql）"
for f in $(ls -1 "$SQL_DIR"/*.sql 2>/dev/null | sort || true); do
    base="$(basename "$f")"
    if [ "$base" = "$LEDGER_BASENAME" ]; then
        continue
    fi
    if ! apply_one "$base" "$f"; then
        FAILED_SCRIPT="$base"
        break
    fi
done
echo ""

# ---- 失败即停：不跑 seed、不跑 upgrade，交回非 0 退出码 ----
if [ "$FAILED" != "0" ] || [ "$BLOCKED" != "0" ]; then
    echo "========================================="
    mark_fail "迁移中断（失败=${FAILED} 被拦=${BLOCKED}）；未执行的脚本保持原状，请修复后重跑"
    echo "        停在: ${FAILED_SCRIPT:-（破坏性闸门）}"
    echo "        提示: 全部脚本幂等，修好后直接重跑本脚本即可，不需要回滚"
    echo "========================================="
    exit 1
fi

# ---- 2) 种子（sql/seed/*.sql，INSERT IGNORE 幂等）----
echo "2) 种子（sql/seed/*.sql）"
for f in $(ls -1 "$SQL_DIR"/seed/*.sql 2>/dev/null | sort || true); do
    if ! apply_one "seed/$(basename "$f")" "$f"; then
        FAILED_SCRIPT="seed/$(basename "$f")"
        break
    fi
done
echo ""

# ---- 3) 一次性迁移（sql/upgrade/*.sql，默认人工闸门）----
UPGRADE_FILES="$(ls -1 "$SQL_DIR"/upgrade/*.sql 2>/dev/null | sort || true)"
if [ "$RUN_UPGRADE" = "1" ]; then
    echo "3) 一次性迁移（sql/upgrade/*.sql，RUN_UPGRADE=1 已放行）"
    for f in $UPGRADE_FILES; do
        if ! apply_one "upgrade/$(basename "$f")" "$f"; then
            FAILED_SCRIPT="upgrade/$(basename "$f")"
            break
        fi
    done
else
    echo "3) 一次性迁移（sql/upgrade/*.sql）—— 已跳过（需 RUN_UPGRADE=1）"
    PENDING=0
    for f in $UPGRADE_FILES; do
        key="upgrade/$(basename "$f")"
        if [ "$(ledger_checksum "$key")" != "$(checksum_of "$f")" ]; then
            mark_warn "${key}（未执行过）"
            PENDING=$((PENDING + 1))
        fi
    done
    if [ "$PENDING" = "0" ]; then
        mark_skip "无待执行的一次性迁移"
    fi
fi
echo ""

# ---------- 汇总 ----------
echo "========================================="
if [ "$FAILED" != "0" ] || [ "$BLOCKED" != "0" ]; then
    mark_fail "存在失败/被拦脚本，停止在：${FAILED_SCRIPT:-未知}"
    echo "========================================="
    exit 1
fi
printf '%s\n' "✅ 已执行=${APPLIED}  ⏭️ 跳过=${SKIPPED}  ❌ 失败=${FAILED}  ⛔ 被拦=${BLOCKED}"
if [ -n "$NARROW_SCRIPTS" ]; then
    mark_warn "以下脚本含 MODIFY COLUMN（本仓库惯例是「注释收敛」段；若本次含收窄类型/丢精度变更，请人工复核）："
    for s in $NARROW_SCRIPTS; do
        printf '         %s\n' "$s"
    done
fi
echo "========================================="

# 台账里仍有 failed 的脚本也要交回非 0：避免「本次没动，但库里还有没收敛的」
if [ "$LEDGER_EXISTS" = "1" ] && [ "$DRY_RUN" != "1" ]; then
    STILL_FAILED="$(q "SELECT COUNT(*) FROM schema_migration WHERE status='failed';")"
    if [ "$STILL_FAILED" != "0" ]; then
        mark_fail "台账里仍有 ${STILL_FAILED} 个脚本处于 failed 状态，请排查后重跑"
        exit 1
    fi
fi
exit 0
