#!/bin/bash
# ============================================
# AI三千问 - 一键安装配置脚本
# ============================================
# 用法: bash setup.sh
# 说明: 本脚本会引导你完成全程配置
#       包括 MySQL、Node.js、Python RAG 服务
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "=========================================="
echo "  🚀 AI三千问 安装配置向导"
echo "=========================================="
echo ""

# ─── 前置检查 ─────────────────────────────

echo "📋 正在检查环境..."

# Node.js
if command -v node &>/dev/null; then
    echo "  ✅ Node.js: $(node -v)"
else
    echo "  ❌ 未安装 Node.js，请先安装: https://nodejs.org/"
    exit 1
fi

# npm
if command -v npm &>/dev/null; then
    echo "  ✅ npm: $(npm -v)"
else
    echo "  ❌ 未安装 npm"
    exit 1
fi

# Python3
if command -v python3 &>/dev/null; then
    echo "  ✅ Python3: $(python3 --version)"
else
    echo "  ❌ 未安装 Python3，请先安装"
    exit 1
fi

# MySQL
if command -v mysql &>/dev/null || command -v mariadb &>/dev/null; then
    echo "  ✅ MySQL/MariaDB 已安装"
else
    echo "  ⚠️  未检测到 MySQL，请确保已安装并运行"
fi

echo ""
echo "=========================================="
echo ""

# ─── 步骤 1: 安装 Node.js 依赖 ────────────

echo "📦 [1/5] 安装 Node.js 依赖..."
cd "$SCRIPT_DIR/server"
npm install
echo "  ✅ Node.js 依赖安装完成"
cd "$SCRIPT_DIR"
echo ""

# ─── 步骤 2: 配置后端 ──────────────────────

echo "⚙️ [2/5] 配置后端服务..."

if [ ! -f "$SCRIPT_DIR/server/config.js" ]; then
    cp "$SCRIPT_DIR/server/config.example.js" "$SCRIPT_DIR/server/config.js"
    echo "  📝 已创建 config.js 模板"
    echo ""
    echo "  ⚠️  请编辑 server/config.js，填入以下信息："
    echo "      1. DeepSeek API Key（必填）"
    echo "      2. MySQL 数据库连接信息（必填）"
    echo "      3. 管理员密码（必填）"
    echo "      4. 阿里云短信配置（选填，用于手机号验证码登录）"
    echo ""
    read -p "  编辑完成后按 Enter 继续..."
else
    echo "  ✅ config.js 已存在，跳过"
fi

echo ""

# ─── 步骤 3: 初始化 MySQL 数据库 ──────────

echo "🗄️ [3/5] 初始化 MySQL 数据库..."

echo "  即将创建数据库并导入表结构..."
echo "  请确保 MySQL 服务已启动"
echo ""

# 检查 MySQL 连接方式
if mysql -u root -e "SELECT 1" &>/dev/null 2>&1; then
    # root 无密码（unix_socket）
    echo "  🔌 使用 root (unix_socket) 连接 MySQL..."
    mysql -u root -e "CREATE DATABASE IF NOT EXISTS ai3000 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    mysql -u root ai3000 < "$SCRIPT_DIR/server/schema.sql"
    echo "  ✅ MySQL 数据库初始化完成！"
    echo "  📌 数据库: ai3000"
    echo "  📌 用户: root（请在生产环境中创建独立用户）"
elif mysql -u root -p -e "SELECT 1" &>/dev/null 2>&1; then
    echo "  🔑 MySQL root 需要密码..."
    mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS ai3000 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    mysql -u root -p ai3000 < "$SCRIPT_DIR/server/schema.sql"
else
    echo "  ⚠️  无法自动连接 MySQL，请手动执行："
    echo "     mysql -u root -p"
    echo "     > CREATE DATABASE ai3000 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    echo "     > source server/schema.sql;"
    read -p "  完成后按 Enter 继续..."
fi

echo ""

# ─── 步骤 4: 安装并配置 RAG 服务 ──────────

echo "🧠 [4/5] 安装配置 RAG 向量知识库..."

# 检测是否已有 config.yaml
if [ ! -f "$SCRIPT_DIR/server/rag/config.yaml" ]; then
    cp "$SCRIPT_DIR/server/rag/config.yaml.example" "$SCRIPT_DIR/server/rag/config.yaml"
    echo "  📝 已创建 RAG 配置模板"
    echo ""
    echo "  ⚠️  请编辑 server/rag/config.yaml，填入以下信息："
    echo "      1. embedding 模式（推荐 local，免费）"
    echo "      2. DeepSeek API Key（必填，与 server/config.js 保持一致）"
    echo "      3. 向量库存储路径（默认 ./vector_db）"
    echo ""
    read -p "  编辑完成后按 Enter 继续..."
else
    echo "  ✅ config.yaml 已存在，跳过"
fi

echo "  📦 安装 Python 依赖..."
cd "$SCRIPT_DIR/server/rag"

if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "  ✅ Python 虚拟环境已创建"
fi

source venv/bin/activate
pip install -r requirements.txt -q
deactivate
echo "  ✅ Python 依赖安装完成"

cd "$SCRIPT_DIR"
echo ""

# ─── 步骤 5: 下载古籍 ────────────────────

echo "📚 [5/5] 准备古籍知识库..."

BOOKS_DIR="$SCRIPT_DIR/server/data/books"
mkdir -p "$BOOKS_DIR"

if [ "$(ls -A "$BOOKS_DIR" 2>/dev/null | wc -l)" -gt 0 ]; then
    echo "  ✅ 古籍文本已存在 ($(ls "$BOOKS_DIR" | wc -l) 个文件)"
else
    echo ""
    echo "  📖 古籍文本文件需要单独下载："
    echo "  🔗 https://github.com/garychowcmu/daizhigev20/tree/master/易藏"
    echo ""
    echo "  下载后请解压到: $BOOKS_DIR"
    echo ""
    read -p "  完成后按 Enter 继续..."
fi

echo ""
echo "=========================================="
echo ""
echo "  ✅ 安装配置完成！"
echo ""
echo "  ▶  启动主服务:"
echo "      cd server && node auth-server.js"
echo ""
echo "  ▶  启动 RAG 服务（新终端）:"
echo "      cd server/rag && bash start.sh"
echo ""
echo "  ▶  访问地址: http://localhost:3301"
echo ""
echo "=========================================="
