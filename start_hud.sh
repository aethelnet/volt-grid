#!/usr/bin/env bash
# VoltGrid Cyber-Physical Studio Launcher
set -e

cd "$(dirname "$0")"

PORT="${PORT:-8050}"
HOST="${HOST:-0.0.0.0}"

echo "================================================================="
echo "  VOLTGRID // 3-PHASE FORTESCUE & DIN VDE DIAGNOSTICS STUDIO"
echo "  URL: http://localhost:${PORT}"
echo "================================================================="

export PYTHONPATH="."
exec python3 -m uvicorn backend.app:app --host "${HOST}" --port "${PORT}"
