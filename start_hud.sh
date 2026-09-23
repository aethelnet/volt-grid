#!/usr/bin/env bash
# AethelGrid SRE Studio Launcher
set -e

cd "$(dirname "$0")"

PORT="${PORT:-8050}"
HOST="${HOST:-0.0.0.0}"

echo "================================================================="
echo "  AETHELGRID // MONOREPO DATABASE & INVARIANT SRE STUDIO"
echo "  Port: http://${HOST}:${PORT}"
echo "================================================================="

export PYTHONPATH="."
exec python3 -m uvicorn backend.app:app --host "${HOST}" --port "${PORT}"
