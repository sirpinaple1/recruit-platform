#!/bin/bash
# ====================================
# recruit-platform 数据库初始化脚本
# 依据：docs/architecture/adr/ADR-002-database-single-source.md
#
# 把 recruit-server/sql/ 作为唯一真源按序灌库（不依赖本机 mysql 客户端，走 docker exec）：
#   sql/*.sql         DDL        —— CREATE TABLE IF NOT EXISTS，始终执行
#   sql/seed/*.sql    种子数据    —— INSERT IGNORE，始终执行，天然幂等
#   sql/upgrade/*.sql 一次性迁移  —— 本脚本【不执行】，需人工单独跑（见文件头说明）
#
# 特性：可重复执行。所有脚本均为幂等写法，重复跑不会重复建表或重复插种子。
#
# 用法：
#   ./scripts/db-bootstrap.sh
#   MYSQL_CONTAINER=recruit-mysql MYSQL_PASSWORD=xxx ./scripts/db-bootstrap.sh
# ====================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

MYSQL_CONTAINER="${MYSQL_CONTAINER:-recruit-mysql}"
MYSQL_DATABASE="${MYSQL_DATABASE:-recruit_platform}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-recruit2024}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="${SCRIPT_DIR}/../recruit-server/sql"

echo "========================================="
echo "recruit-platform 数据库初始化"
echo "========================================="
echo "容器: ${MYSQL_CONTAINER}  数据库: ${MYSQL_DATABASE}"
echo "真源: ${SQL_DIR}"
echo ""

# ---------- 前置检查 ----------
if [ ! -d "$SQL_DIR" ]; then
    echo -e "${RED}✗${NC} 未找到 SQL 真源目录: ${SQL_DIR}"
    exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${MYSQL_CONTAINER}$"; then
    echo -e "${RED}✗${NC} MySQL 容器未运行，请先执行: docker-compose up -d"
    exit 1
fi

mysql_exec() {
    # --default-character-set=utf8mb4 必须带：否则容器内 mysql 客户端可能以 latin1 解释结果集，
    # 把完好的中文印成 ????? / 乱码（数据本身没问题，是读数问题），导致误判"种子数据损坏"。
    docker exec -i "$MYSQL_CONTAINER" mysql --default-character-set=utf8mb4 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$@"
}

if ! mysql_exec -e "SELECT 1;" &>/dev/null; then
    echo -e "${RED}✗${NC} MySQL 连接失败，请检查账号密码"
    exit 1
fi

if ! mysql_exec -e "USE \`${MYSQL_DATABASE}\`;" &>/dev/null; then
    echo -e "${RED}✗${NC} 数据库 ${MYSQL_DATABASE} 不存在（应由 docker-compose 的 MYSQL_DATABASE 创建）"
    exit 1
fi

# ---------- 应用脚本 ----------
FAILED=0

apply_dir() {
    local dir="$1"
    local label="$2"
    local files
    files=$(ls "$dir"/*.sql 2>/dev/null | sort || true)

    if [ -z "$files" ]; then
        echo -e "${YELLOW}⚠${NC} ${label}: 无 .sql 文件，跳过"
        echo ""
        return 0
    fi

    echo "${label}:"
    local file output
    for file in $files; do
        if output=$(mysql_exec "$MYSQL_DATABASE" < "$file" 2>&1); then
            echo -e "  ${GREEN}✓${NC} $(basename "$file")"
        else
            echo -e "  ${RED}✗${NC} $(basename "$file")"
            echo "$output" | sed 's/^/      /'
            FAILED=1
        fi
    done
    echo ""
}

apply_dir "${SQL_DIR}" "1) DDL 建表（sql/*.sql）"
apply_dir "${SQL_DIR}/seed" "2) 种子数据（sql/seed/*.sql）"

# ---------- 核对 ----------
echo "3) 当前表清单:"
mysql_exec "$MYSQL_DATABASE" -e "SHOW TABLES;" | tail -n +2 | sed 's/^/     /'
echo ""

echo "   账号:"
mysql_exec "$MYSQL_DATABASE" -e "SELECT username, real_name, role, status FROM sys_user;" \
    | sed 's/^/     /'
echo ""

if [ -f "${SQL_DIR}/upgrade/legacy_orphan_tables_rename_20260916_V1.sql" ]; then
    echo -e "${YELLOW}提示${NC}: sql/upgrade/ 下存在一次性迁移脚本，本脚本不自动执行。"
    echo "      仅当你的环境曾跑过旧版 docker/mysql/init/001_schema.sql 时才需要手动执行："
    echo "      mysql -h 127.0.0.1 -P 3307 -uroot -p ${MYSQL_DATABASE} < recruit-server/sql/upgrade/legacy_orphan_tables_rename_20260916_V1.sql"
    echo ""
fi

echo "========================================="
if [ "$FAILED" = 0 ]; then
    echo -e "${GREEN}✓ 初始化完成${NC}"
else
    echo -e "${RED}✗ 存在失败脚本，请检查上方输出${NC}"
fi
echo "========================================="

exit "$FAILED"
