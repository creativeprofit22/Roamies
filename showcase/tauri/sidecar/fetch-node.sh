#!/bin/bash
# Puts a Node.js runtime at src-tauri/binaries/node-<target triple>[.exe] so the app ships its own Node
# (users don't need Node installed). The download is checked against Node's published SHA-256 sums.
# ./fetch-node.sh [target-triple]   (default: this machine's)
set -euo pipefail
cd "$(dirname "$0")"
NODE_VERSION="v24.22.2"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$TRIPLE" in
  aarch64-apple-darwin) PKG="darwin-arm64"; EXT="tar.gz" ;;
  x86_64-apple-darwin) PKG="darwin-x64"; EXT="tar.gz" ;;
  x86_64-pc-windows-msvc) PKG="win-x64"; EXT="zip" ;;
  aarch64-pc-windows-msvc) PKG="win-arm64"; EXT="zip" ;;
  x86_64-unknown-linux-gnu) PKG="linux-x64"; EXT="tar.xz" ;;
  aarch64-unknown-linux-gnu) PKG="linux-arm64"; EXT="tar.xz" ;;
  *) echo "fetch-node: no Node build for $TRIPLE" >&2; exit 1 ;;
esac
BIN_DIR="../src-tauri/binaries"
OUT="$BIN_DIR/node-$TRIPLE"; [[ "$PKG" == win-* ]] && OUT="$OUT.exe"
STAMP="$OUT.version"
if [ -f "$OUT" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$NODE_VERSION" ]; then exit 0; fi
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
NAME="node-$NODE_VERSION-$PKG"
BASE="https://nodejs.org/dist/$NODE_VERSION"
echo "fetch-node: $NAME" >&2
curl -fsSL --retry 3 -o "$TMP/$NAME.$EXT" "$BASE/$NAME.$EXT"
curl -fsSL --retry 3 -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
WANT="$(grep "  $NAME.$EXT\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null; then GOT="$(sha256sum "$TMP/$NAME.$EXT" | cut -d' ' -f1)"; else GOT="$(shasum -a 256 "$TMP/$NAME.$EXT" | cut -d' ' -f1)"; fi
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "fetch-node: checksum mismatch for $NAME.$EXT" >&2; exit 1; }
case "$EXT" in
  zip)
    if command -v unzip >/dev/null; then unzip -q "$TMP/$NAME.$EXT" "$NAME/node.exe" -d "$TMP"
    else powershell -NoProfile -Command "Expand-Archive -LiteralPath '$(cygpath -w "$TMP/$NAME.$EXT" 2>/dev/null || echo "$TMP/$NAME.$EXT")' -DestinationPath '$(cygpath -w "$TMP" 2>/dev/null || echo "$TMP")'"; fi
    cp "$TMP/$NAME/node.exe" "$OUT" ;;
  *)
    tar -xf "$TMP/$NAME.$EXT" -C "$TMP" "$NAME/bin/node"
    cp "$TMP/$NAME/bin/node" "$OUT"; chmod 755 "$OUT" ;;
esac
echo "$NODE_VERSION" > "$STAMP"
