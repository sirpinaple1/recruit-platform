#!/bin/bash
# ====================================
# recruit-platform 前端一键启动脚本
# ====================================
# 功能：自动启动 Docker 基础设施、初始化数据库、启动后端服务、最后启动前端
# 用法：./start-frontend.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_step() {
    echo ""
    echo -e "${BLUE}=========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}=========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# 检查依赖
check_dependencies() {
    print_step "步骤 1/5: 检查依赖"
    
    local missing_deps=false
    
    if ! command -v docker &>/dev/null; then
        print_error "未安装 Docker"
        missing_deps=true
    else
        print_success "Docker 已安装"
    fi
    
    if ! command -v mvn &>/dev/null; then
        print_error "未安装 Maven"
        missing_deps=true
    else
        print_success "Maven 已安装"
    fi
    
    if ! command -v npm &>/dev/null; then
        print_error "未安装 npm"
        missing_deps=true
    else
        print_success "npm 已安装"
    fi
    
    if [ "$missing_deps" = true ]; then
        print_error "缺少必要依赖，请先安装后再运行"
        exit 1
    fi
}

# 启动 Docker 服务
start_docker_services() {
    print_step "步骤 2/5: 启动 Docker 基础设施"
    
    cd "$SCRIPT_DIR"
    
    if docker ps --format '{{.Names}}' | grep -q "^recruit-mysql$"; then
        print_warning "MySQL 容器已在运行"
    else
        print_success "正在启动 Docker 服务..."
        docker-compose up -d
        
        print_success "等待 MySQL 就绪 (最多 30 秒)..."
        local count=0
        while [ $count -lt 30 ]; do
            if docker exec recruit-mysql mysql -uroot -precruit2024 -e "SELECT 1;" &>/dev/null; then
                print_success "MySQL 已就绪"
                break
            fi
            sleep 1
            count=$((count + 1))
        done
        
        if [ $count -eq 30 ]; then
            print_error "MySQL 启动超时"
            exit 1
        fi
    fi
}

# 初始化数据库
init_database() {
    print_step "步骤 3/5: 初始化数据库"
    
    cd "$SCRIPT_DIR"
    
    if [ -f "./scripts/db-bootstrap.sh" ]; then
        ./scripts/db-bootstrap.sh
    else
        print_error "未找到数据库初始化脚本"
        exit 1
    fi
}

# 启动后端服务
start_backend() {
    print_step "步骤 4/5: 启动后端服务"
    
    cd "$SCRIPT_DIR/recruit-server"
    
    # 检查后端是否已在运行
    if lsof -i:6017 &>/dev/null; then
        print_warning "后端服务已在端口 6017 运行"
        read -p "是否重启后端服务？(y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            print_success "正在停止现有后端服务..."
            pkill -f "recruit-server" || true
            sleep 2
        else
            print_success "保持现有后端服务运行"
            return
        fi
    fi
    
    print_success "正在后台启动后端服务..."
    nohup mvn spring-boot:run > "$SCRIPT_DIR/backend.log" 2>&1 &
    BACKEND_PID=$!
    
    print_success "等待后端服务就绪 (最多 60 秒)..."
    local count=0
    while [ $count -lt 60 ]; do
        if curl -s http://localhost:6017/api/health &>/dev/null; then
            print_success "后端服务已就绪 (PID: $BACKEND_PID)"
            break
        fi
        sleep 1
        count=$((count + 1))
    done
    
    if [ $count -eq 60 ]; then
        print_error "后端服务启动超时，请查看日志: tail -f $SCRIPT_DIR/backend.log"
        exit 1
    fi
}

# 启动前端服务
start_frontend() {
    print_step "步骤 5/5: 启动前端服务"
    
    cd "$SCRIPT_DIR/recruit-web"
    
    # 检查是否需要安装依赖
    if [ ! -d "node_modules" ]; then
        print_success "首次运行，正在安装前端依赖..."
        npm install
    fi
    
    # 检查前端是否已在运行
    if lsof -i:5173 &>/dev/null; then
        print_warning "前端服务已在端口 5173 运行"
        read -p "是否重启前端服务？(y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            print_success "正在停止现有前端服务..."
            pkill -f "vite" || true
            sleep 2
        else
            print_success "保持现有前端服务运行"
            return
        fi
    fi
    
    print_success "正在启动前端服务..."
    echo ""
    echo -e "${GREEN}=========================================${NC}"
    echo -e "${GREEN}前端服务启动成功！${NC}"
    echo -e "${GREEN}=========================================${NC}"
    echo ""
    echo "访问地址："
    echo -e "  ${BLUE}http://localhost:5173${NC}"
    echo ""
    echo "测试账号："
    echo "  - 管理员: admin / admin123"
    echo "  - HR: hr001 / hr123456"
    echo ""
    echo "后端日志："
    echo "  tail -f $SCRIPT_DIR/backend.log"
    echo ""
    echo -e "${YELLOW}按 Ctrl+C 停止前端服务${NC}"
    echo ""
    
    npm run dev
}

# 主流程
main() {
    echo ""
    echo -e "${BLUE}=====================================${NC}"
    echo -e "${BLUE}recruit-platform 前端一键启动${NC}"
    echo -e "${BLUE}=====================================${NC}"
    
    check_dependencies
    start_docker_services
    init_database
    start_backend
    start_frontend
}

# 捕获 Ctrl+C
trap 'echo -e "\n${YELLOW}前端服务已停止${NC}"; exit 0' INT

main
