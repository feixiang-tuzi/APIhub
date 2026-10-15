#!/usr/bin/env bash
# API Hub · Linux / macOS 启动脚本
# 用法：双击，或在终端里 ./start.sh
set -e
cd "$(dirname "$0")"

PYEXE=""
if command -v python3 >/dev/null 2>&1; then PYEXE="python3"
elif command -v python >/dev/null 2>&1; then PYEXE="python"
fi

if [ -z "$PYEXE" ]; then
  echo ""
  echo "  [!] 未找到 Python。请安装 Python 3.8+ 后重试。"
  echo "      https://www.python.org/downloads/"
  echo ""
  read -p "按回车键退出..."
  exit 1
fi

echo "Starting API Hub ..."
$PYEXE server.py
