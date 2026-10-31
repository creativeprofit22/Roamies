#!/usr/bin/env bash
# Downloads NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX export by istupakov, CC-BY-4.0) into models/parakeet/.
# Pinned to one commit; the hashes must match src-tauri/voice-engines.json (a sidecar test checks this).
set -euo pipefail
cd "$(dirname "$0")"

REV=8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce
BASE="https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/$REV"
DEST=models/parakeet
FILES=(
  "encoder-model.int8.onnx 6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"
  "decoder_joint-model.int8.onnx eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"
  "vocab.txt d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"
)

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$DEST"
for entry in "${FILES[@]}"; do
  name=${entry%% *}; want=${entry##* }
  if [ -s "$DEST/$name" ] && [ "$(sha "$DEST/$name")" = "$want" ]; then continue; fi
  echo "downloading $name"
  curl -fL --retry 3 -C - -o "$DEST/$name.part" "$BASE/$name"
  got=$(sha "$DEST/$name.part")
  if [ "$got" != "$want" ]; then rm -f "$DEST/$name.part"; echo "$name: checksum mismatch ($got)" >&2; exit 1; fi
  mv "$DEST/$name.part" "$DEST/$name"
done
echo "model ready in $DEST"
