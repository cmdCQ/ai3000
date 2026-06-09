#!/bin/bash
# ============================================
# AI三千问 - 一键安装配置脚本
# ============================================
# 用法: bash setup.sh
# 说明: 自动检查环境、安装依赖、初始化数据库、
#       配置 RAG 向量知识库，引导用户完成部署
# ============================================

# 遇到错误是否继续？部分非致命错误跳过
# 致命错误（缺 Node.js/Python）直接退出
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ─── 颜色工具 ─────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; [ "$2" = "fatal" ] && exit 1; }
info() { echo -e "  ${CYAN}ℹ️  $1${NC}"; }
hr()   { echo "────────────────────────────────────────────"; }

# ─── 标题 ─────────────────────────────────

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}        🚀 AI三千问  安装配置向导        ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── 1. 前置检查 ─────────────────────────

echo "📋 ${YELLOW}检查环境...${NC}"
echo ""

check_node() {
  if ! command -v node &>/dev/null; then
    fail "未安装 Node.js (https://nodejs.org/)" fatal
  fi
  ok "Node.js $(node -v)"
}

check_npm() {
  if ! command -v npm &>/dev/null; then
    fail "未安装 npm" fatal
  fi
  ok "npm $(npm -v)"
}

check_python() {
  if ! command -v python3 &>/dev/null; then
    fail "未安装 Python3 (请先安装 python3 + python3-venv)" fatal
  fi
  ok "Python3 $(python3 --version)"
}

check_pip() {
  if ! python3 -c "import pip" &>/dev/null 2>&1; then
    warn "pip3 未安装，尝试安装..."
    python3 -m ensurepip --upgrade &>/dev/null 2>&1 || {
      fail "pip3 安装失败，请手动安装: apt install python3-pip (Debian) 或 brew install python (macOS)" fatal
    }
  fi
  ok "pip3 可用"
}

check_venv() {
  if ! python3 -c "import venv" &>/dev/null 2>&1; then
    fail "python3-venv 未安装，请先安装:\n     apt install python3-venv   (Debian/Ubuntu)\n     yum install python3-virtualenv  (CentOS)\n     brew install python   (macOS)" fatal
  fi
  ok "python3-venv 可用"
}

check_mysql() {
  if command -v mysql &>/dev/null; then
    ok "MySQL 客户端已安装"
  elif command -v mariadb &>/dev/null; then
    ok "MariaDB 客户端已安装"
  else
    warn "未检测到 MySQL/MariaDB 客户端，请确保已安装并运行"
  fi
}

check_node
check_npm
check_python
check_pip
check_venv
check_mysql

echo ""

# ─── 2. 安装 Node 依赖 ───────────────────

echo -e "${YELLOW}[1/5]${NC} 安装 Node.js 依赖..."
hr
(
  cd "$SCRIPT_DIR/server"
  npm install --loglevel=warn 2>&1 | sed 's/^/  /'
)
ok "Node.js 依赖安装完成"
echo ""

# ─── 3. 配置后端 ─────────────────────────

echo -e "${YELLOW}[2/5]${NC} 配置后端服务..."
hr

if [ ! -f "$SCRIPT_DIR/server/config.js" ]; then
  cp "$SCRIPT_DIR/server/config.example.js" "$SCRIPT_DIR/server/config.js"
  ok "已创建 config.js 模板"
  echo ""
  echo "  请编辑 ${CYAN}server/config.js${NC}，填入以下信息："
  echo "    ${GREEN}①${NC} DeepSeek API Key — 必填，从 platform.deepseek.com 获取"
  echo "    ${GREEN}②${NC} MySQL 连接信息    — 必填（host/user/password/database）"
  echo "    ${GREEN}③${NC} 管理员密码        — 必填，登录后台用"
  echo "    ${GREEN}④${NC} 阿里云短信配置    — 选填，用于手机号验证码登录"
  echo ""
  read -p "  编辑完成后按 Enter 继续... " _
else
  ok "config.js 已存在，跳过"
fi

echo ""

# ─── 4. 初始化 MySQL ─────────────────────

echo -e "${YELLOW}[3/5]${NC} 初始化 MySQL 数据库..."
hr

echo "  即将创建 ai3000 数据库并导入表结构，请确保 MySQL 服务已启动"
echo ""

do_mysql() {
  if mysql -u root -e "SELECT 1" &>/dev/null 2>&1; then
    echo -n "  🔌 连接 MySQL (unix_socket)... "
    mysql -u root -e "CREATE DATABASE IF NOT EXISTS ai3000 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    mysql -u root ai3000 < "$SCRIPT_DIR/server/schema.sql"
    echo -e "${GREEN}成功${NC}"
    return 0
  fi
  return 1
}

if do_mysql; then
  ok "数据库初始化完成"
  info "数据库: ai3000 / 用户: root（建议生产环境创建独立用户）"
else
  warn "无法自动连接 MySQL，请手动执行："
  echo ""
  echo "    mysql -u root -p"
  echo "    > CREATE DATABASE ai3000 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  echo "    > USE ai3000;"
  echo "    > SOURCE server/schema.sql;"
  echo ""
  read -p "  完成后按 Enter 继续... " _
fi

echo ""

# ─── 5. 配置 RAG ─────────────────────────

echo -e "${YELLOW}[4/5]${NC} 安装配置 RAG 向量知识库..."
hr

# 5a. 配置文件
if [ ! -f "$SCRIPT_DIR/server/rag/config.yaml" ]; then
  cp "$SCRIPT_DIR/server/rag/config.yaml.example" "$SCRIPT_DIR/server/rag/config.yaml"
  echo ""
  ok "已创建 RAG 配置模板"
  echo ""
  echo "  请编辑 ${CYAN}server/rag/config.yaml${NC}，填入以下信息："
  echo "    ${GREEN}①${NC} embedding 模式 — 推荐 local（免费本地 ONNX 模型）"
  echo "    ${GREEN}②${NC} DeepSeek API Key — 必填，与 server/config.js 保持一致"
  echo "    ${GREEN}③${NC} 向量库存储路径 — 默认 ./vector_db"
  echo ""
  read -p "  编辑完成后按 Enter 继续... " _
else
  ok "config.yaml 已存在，跳过"
fi

# 5b. Python 虚拟环境 + 依赖
echo ""
echo "  📦 安装 Python 虚拟环境和依赖..."
echo ""

VENV_DIR="$SCRIPT_DIR/server/rag/venv"

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
  ok "虚拟环境已创建"
fi

# 用 venv 的 pip 直接安装，避免 source/subshell 问题
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/server/rag/requirements.txt" -q 2>&1 | sed 's/^/  /'
ok "Python 依赖安装完成"

echo ""

# ─── 6. 古籍下载指引 ─────────────────────

echo -e "${YELLOW}[5/5]${NC} 准备古籍知识库..."
hr

BOOKS_DIR="$SCRIPT_DIR/server/data/books"
mkdir -p "$BOOKS_DIR"

FILE_COUNT=$(ls -1 "$BOOKS_DIR"/*.txt 2>/dev/null | wc -l)

if [ "$FILE_COUNT" -gt 0 ]; then
  ok "古籍文本已存在（${FILE_COUNT} 个文件）"
else
  echo ""
  echo "  📖 古籍文本文件需要单独下载（300+ 本命理古籍）："
  echo ""
  echo -e "    🔗 ${CYAN}https://github.com/garychowcmu/daizhigev20/tree/master/易藏${NC}"
  echo ""
  echo "  下载后解压到: ${YELLOW}$BOOKS_DIR${NC}"
  echo "  目录里放的是 .txt 格式的纯文本文件"
  echo ""
  read -p "  完成后按 Enter 继续... " _
fi

echo ""

# ─── 完成 ────────────────────────────────

echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}          ✅ 安装配置完成！               ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}▶${NC} 启动主服务:"
echo "      cd server && node auth-server.js"
echo ""
echo -e "  ${GREEN}▶${NC} 启动 RAG 服务（另开终端）:"
echo "      cd server/rag && bash start.sh"
echo ""
echo -e "  ${GREEN}▶${NC} 访问地址:"
echo "      http://localhost:3301"
echo ""
echo -e "  ${GREEN}▶${NC} 古籍入库（启动后）:"
echo "      在管理后台 → 古籍管理 → 书籍入库"
echo "      或命令行: cd server/rag && source venv/bin/activate && python scripts/ingest.py ..."
echo ""
