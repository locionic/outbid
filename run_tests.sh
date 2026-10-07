#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m unittest tools.test_extract -v
node tools/verify_app.mjs
