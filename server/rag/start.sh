#!/bin/bash
# AI三千问 - RAG 后端启动脚本
# =============================

set -e

cd "$(dirname "$0")"

echo "📦 安装依赖..."
pip3 install -r requirements.txt -q

echo ""
echo "🚀 启动 AI三千问 RAG 后端..."
python3 -m uvicorn src.main:app \
    --host 0.0.0.0 \
    --port 8800 \
    --reload
