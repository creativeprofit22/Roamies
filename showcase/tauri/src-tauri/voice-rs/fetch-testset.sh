#!/usr/bin/env bash
# Builds the public bench set: the first N (default 200) LibriSpeech test-clean utterances by sorted id,
# as 16 kHz mono WAV + reference .txt in bench-data/librispeech/. LibriSpeech is CC BY 4.0 (openslr SLR12).
# Needs curl, tar and ffmpeg. Usage: ./fetch-testset.sh [N]
set -euo pipefail
cd "$(dirname "$0")"

N=${1:-200}
URL=https://www.openslr.org/resources/12/test-clean.tar.gz
MD5=32fa31d27d2e1cad72775fee3f4849a9
CACHE=bench-data/cache
OUT=bench-data/librispeech

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (winget install Gyan.FFmpeg)" >&2; exit 1; }
mkdir -p "$CACHE" "$OUT"

TGZ=$CACHE/test-clean.tar.gz
if [ ! -f "$CACHE/LibriSpeech/.extracted" ]; then
  if [ ! -f "$TGZ" ]; then
    curl -fL --retry 3 -o "$TGZ.part" "$URL"
    mv "$TGZ.part" "$TGZ"
  fi
  got=$(md5sum "$TGZ" | cut -d' ' -f1)
  [ "$got" = "$MD5" ] || { echo "md5 mismatch for $TGZ: $got" >&2; rm -f "$TGZ"; exit 1; }
  tar -xzf "$TGZ" -C "$CACHE"
  touch "$CACHE/LibriSpeech/.extracted"
fi

# "<id> <TRANSCRIPT>" lines from every chapter, sorted by id, first N.
find "$CACHE/LibriSpeech/test-clean" -name '*.trans.txt' -exec cat {} + | LC_ALL=C sort | awk -v n="$N" 'NR <= n' > "$OUT/.list"
count=0
while read -r id text; do
  speaker=${id%%-*}; rest=${id#*-}; chapter=${rest%%-*}
  flac="$CACHE/LibriSpeech/test-clean/$speaker/$chapter/$id.flac"
  [ -f "$OUT/$id.wav" ] || ffmpeg -v error -nostdin -y -i "$flac" -ac 1 -ar 16000 -c:a pcm_s16le "$OUT/$id.wav"
  printf '%s\n' "$text" > "$OUT/$id.txt"
  count=$((count + 1))
done < "$OUT/.list"
rm -f "$OUT/.list"
echo "$count clips in $OUT ($(du -sh "$OUT" | cut -f1)); delete $CACHE to free the download"
