#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .build
tsc -p tsconfig.json
cp .build/background.js ./background.js
cp .build/content.js ./content.js
cp .build/popup.js ./popup.js
