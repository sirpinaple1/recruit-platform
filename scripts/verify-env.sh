#!/bin/bash
# ====================================
# recruit-platform 环境验证脚本
# ====================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "recruit-platform 环境验证"
echo "========================================="
echo ""

# 检查 Docker 服务
echo "1. 检查 Docker 容器状态..."
SERVICES=("recruit-mysql" "recruit-redis" "recruit-rabbitmq" "recruit-minio" "recruit-chromadb")
ALL_UP=true

for service in "${SERVICES[@]}"; do
    if docker ps --format '{{.Names}}' | grep -q "^${service}$"; then
        STATUS=$(docker ps --filter "name=${service}" --format '{{.Status}}')
        echo -e "${GREEN}✓${NC} ${service}: ${STATUS}"
    else
        echo -e "${RED}✗${NC} ${service}: 未运行"
        ALL_UP=false
    fi
done
echo ""

# 检查 MySQL
echo "2. 检查 MySQL 连接..."
if docker exec recruit-mysql mysql -uroot -precruit2024 -e "SELECT 1;" &>/dev/null; then
    TABLE_COUNT=$(docker exec recruit-mysql mysql -uroot -precruit2024 recruit_platform -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='recruit_platform';" 2>/dev/null | tail -1)
    echo -e "${GREEN}✓${NC} MySQL 连接正常 (数据库表数: ${TABLE_COUNT})"
else
    echo -e "${RED}✗${NC} MySQL 连接失败"
    ALL_UP=false
fi
echo ""

# 检查 Redis
echo "3. 检查 Redis 连接..."
if docker exec recruit-redis redis-cli ping &>/dev/null; then
    echo -e "${GREEN}✓${NC} Redis 连接正常"
else
    echo -e "${RED}✗${NC} Redis 连接失败"
    ALL_UP=false
fi
echo ""

# 检查 RabbitMQ
echo "4. 检查 RabbitMQ 管理界面..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:15672 | grep -q "200"; then
    echo -e "${GREEN}✓${NC} RabbitMQ 管理界面可访问 (http://localhost:15672)"
else
    echo -e "${YELLOW}⚠${NC} RabbitMQ 管理界面暂时不可访问"
fi
echo ""

# 检查 MinIO
echo "5. 检查 MinIO 服务..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:9001 | grep -q "200"; then
    echo -e "${GREEN}✓${NC} MinIO 控制台可访问 (http://localhost:9001)"
else
    echo -e "${YELLOW}⚠${NC} MinIO 控制台暂时不可访问"
fi
echo ""

# 检查 Ollama
echo "6. 检查 Ollama 模型..."
if command -v ollama &>/dev/null; then
    MODELS=$(ollama list 2>/dev/null | tail -n +2 | wc -l)
    echo -e "${GREEN}✓${NC} Ollama 已安装 (已下载 ${MODELS} 个模型)"
    ollama list 2>/dev/null | tail -n +2 | while read line; do
        echo "  - $line"
    done

    # 检查必需模型
    if ollama list 2>/dev/null | grep -q "bge-m3"; then
        echo -e "${GREEN}✓${NC} bge-m3 模型已就绪"
    else
        echo -e "${YELLOW}⚠${NC} bge-m3 模型未下载"
    fi

    if ollama list 2>/dev/null | grep -q "qwen2.5"; then
        echo -e "${GREEN}✓${NC} qwen2.5 模型已就绪"
    else
        echo -e "${YELLOW}⚠${NC} qwen2.5 模型未下载或正在下载中"
    fi
else
    echo -e "${RED}✗${NC} Ollama 未安装"
    ALL_UP=false
fi
echo ""

# 检查 ChromaDB
echo "7. 检查 ChromaDB 服务..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/v1/heartbeat | grep -q "200"; then
    echo -e "${GREEN}✓${NC} ChromaDB 服务正常 (http://localhost:8000)"
else
    echo -e "${YELLOW}⚠${NC} ChromaDB 服务暂时不可访问"
fi
echo ""

# 总结
echo "========================================="
if [ "$ALL_UP" = true ]; then
    echo -e "${GREEN}✓ 环境验证通过！所有核心服务正常运行${NC}"
else
    echo -e "${YELLOW}⚠ 部分服务未就绪，请检查上述输出${NC}"
fi
echo "========================================="
echo ""

# 输出服务地址
echo "服务访问地址："
echo "  - MySQL: localhost:3306 (root/recruit2024)"
echo "  - Redis: localhost:6379"
echo "  - RabbitMQ: http://localhost:15672 (guest/guest)"
echo "  - MinIO: http://localhost:9001 (minioadmin/minioadmin)"
echo "  - ChromaDB: http://localhost:8000"
echo ""
