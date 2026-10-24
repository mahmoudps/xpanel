#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT="$(readlink -f -- "${BASH_SOURCE[0]}")"
ROOT="$(cd -- "$(dirname -- "$SCRIPT")/.." && pwd -P)"
exec /bin/bash "$ROOT/bin/xpanel-ctl" uninstall "$@"
