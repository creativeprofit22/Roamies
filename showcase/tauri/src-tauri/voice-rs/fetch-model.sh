#!/usr/bin/env bash
# Downloads the streaming Zipformer (English, int8) used by roamies-voice into models/zipformer/.
# Model: k2-fsa/sherpa-onnx asr-models release, Apache-2.0. Set ARCHIVE=path to reuse a downloaded tarball.
set -euo pipefail
cd "$(dirname "$0")"

NAME=sherpa-onnx-streaming-zipformer-en-2023-06-26
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$NAME.tar.bz2"
DEST=models/zipformer
FILES=(
  encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx
  decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx
  joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx
  tokens.txt
)

have_all() { for f in "${FILES[@]}"; do [ -s "$DEST/$f" ] || return 1; done; }
if have_all; then echo "model already in $DEST"; exit 0; fi

mkdir -p "$DEST"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
archive=${ARCHIVE:-}
if [ -z "$archive" ]; then
  archive="$tmp/$NAME.tar.bz2"
  echo "downloading $URL"
  curl -fL --retry 3 -o "$archive" "$URL"
fi
members=()
for f in "${FILES[@]}"; do members+=("$NAME/$f"); done
tar -xjf "$archive" -C "$tmp" "${members[@]}"
for f in "${FILES[@]}"; do mv "$tmp/$NAME/$f" "$DEST/$f"; done
have_all
echo "model ready in $DEST"
