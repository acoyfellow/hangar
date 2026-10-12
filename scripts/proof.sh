#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p receipts
curl -fsS -o /dev/null "${HANGAR_URL:-http://127.0.0.1:1337}/api/hangar" || { echo "start the app first: pnpm dev"; exit 1; }
node scripts/proof.mjs
