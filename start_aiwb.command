#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "== AiWB War Room 启动中 =="
echo "项目目录: $SCRIPT_DIR"
echo

python3 -m pip install -U streamlit pandas google-auth google-api-python-client
streamlit run check_finance.py

