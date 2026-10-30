#!/usr/bin/env bash
# Benchmarks Zipformer, Moonshine tiny and Moonshine small on a dir of name.wav + name.txt pairs.
# One engine per process so peak RAM is clean. Results are appended to bench-data/results.log.
# Usage: ./bench.sh <dir> [config ...]   configs: zipformer moonshine-tiny moonshine-small moonshine-medium
set -euo pipefail
cd "$(dirname "$0")"

DIR=${1:?usage: ./bench.sh <dir of wav+txt> [config ...]}
shift
CONFIGS=("$@")
[ ${#CONFIGS[@]} -gt 0 ] || CONFIGS=(zipformer moonshine-tiny moonshine-small)

cargo build --release --locked
EXE=target/release/roamies-voice
[ -x "$EXE.exe" ] && EXE="$EXE.exe"
LIB=models/moonshine-runtime/moonshine.dll
[ "$(uname -s)" = Darwin ] && LIB=models/moonshine-runtime/libmoonshine.dylib
[ "$(uname -s)" = Linux ] && LIB=models/moonshine-runtime/libmoonshine.so

mkdir -p bench-data
LOG=bench-data/results.log
for cfg in "${CONFIGS[@]}"; do
  case "$cfg" in
    zipformer) ARGS=(--engine zipformer --model-dir models/zipformer) ;;
    moonshine-*)
      size=${cfg#moonshine-}
      ARGS=(--engine moonshine --moonshine-size "$size" --moonshine-lib "$LIB" --model-dir "models/moonshine-$size") ;;
    *) echo "unknown config $cfg" >&2; exit 1 ;;
  esac
  echo "== $cfg on $DIR"
  { echo "## $(date -u +%Y-%m-%dT%H:%M:%SZ) $cfg $DIR"; "$EXE" --bench "$DIR" "${ARGS[@]}" 2>"bench-data/$cfg.misses.log"; } | tee -a "$LOG"
done
echo "results appended to $LOG; per-clip misses in bench-data/<config>.misses.log"
