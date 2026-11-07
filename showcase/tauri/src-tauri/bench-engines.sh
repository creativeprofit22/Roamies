#!/usr/bin/env bash
# Benchmarks both shipped engines (Moonshine small and Parakeet) on the same sets, one command.
# Sets are dirs of name.wav + name.txt; a bare name means voice-rs/bench-data/<name>.
# Results (per-clip WER and S/I/D, then TOTAL and a JSON line) are appended to voice-rs/bench-data/results.log.
# Usage: ./bench-engines.sh [set ...]   default: own librispeech
set -euo pipefail
cd "$(dirname "$0")"

SETS=("$@")
[ ${#SETS[@]} -gt 0 ] || SETS=(own librispeech)
LOG=voice-rs/bench-data/results.log
mkdir -p voice-rs/bench-data

(cd voice-win && cargo build --release --locked)
WIN=voice-win/target/release/roamies-voice-parakeet
[ -x "$WIN.exe" ] && WIN="$WIN.exe"

for set in "${SETS[@]}"; do
  dir=$set
  [ -d "$dir" ] || dir=voice-rs/bench-data/$set
  [ -d "$dir" ] || { echo "no set $set (fetch it with voice-rs/fetch-testset.sh)" >&2; exit 1; }
  abs=$(cd "$dir" && pwd)
  voice-rs/bench.sh "$abs" moonshine-small
  echo "== parakeet on $abs"
  { echo "## $(date -u +%Y-%m-%dT%H:%M:%SZ) parakeet $abs"; "$WIN" --bench "$abs" 2>voice-rs/bench-data/parakeet.misses.log; } | tee -a "$LOG"
done
echo "results appended to $LOG"
