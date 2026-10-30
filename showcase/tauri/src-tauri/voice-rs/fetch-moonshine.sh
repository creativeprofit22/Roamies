#!/usr/bin/env bash
# Downloads Moonshine streaming English models into models/moonshine-<size>/ and, on Windows x64, the
# Moonshine runtime into models/moonshine-runtime/. Usage: ./fetch-moonshine.sh [tiny|small|medium ...]
# Moonshine publishes only static .lib files for Windows (built /MD), so we link them into our own
# moonshine.dll with MSVC link.exe; roamies-voice loads it at runtime. Code and streaming models: MIT.
set -euo pipefail
cd "$(dirname "$0")"

TAG=v0.1.5
RT_NAME=moonshine-voice-windows-x86_64
RT_URL="https://github.com/moonshine-ai/moonshine/releases/download/$TAG/$RT_NAME.tar.gz"
RT_SHA=97c1987e8e1cd77bb5fe3b12ce5aad5172637107e1dfda112ea9b21bac8f4b65
RT_DEST=models/moonshine-runtime
RAW="https://raw.githubusercontent.com/moonshine-ai/moonshine/$TAG"
MODEL_BASE=https://download.moonshine.ai/model
MODEL_REV=quantized_26_08_21
FILES=(frontend.model.ort frontend.weights.ort encoder.ort adapter.ort cross_kv.ort decoder_kv.ort
  streaming_config.json tokenizer.bin)

# sha256 per <size>/<file>; a size without pins is downloaded unverified with a warning.
declare -A SHA=(
  [tiny/frontend.model.ort]=5121b561417b638afce0c6c31b760e37c93cf97f80d9b0031aad1fe7b6f25d61
  [tiny/frontend.weights.ort]=217da24ac6f522ebf02da8ef288e77d1ac68d50d4a6821433182e4fbf4204bbd
  [tiny/encoder.ort]=a8414e1a5dedf9f2093d7680601dd8a9b0433e7020260eafe0e370ead91134ca
  [tiny/adapter.ort]=22ecc949e146c49667fda28d102d4e30749a107dc88a396292aa8f277ef1347c
  [tiny/cross_kv.ort]=143a36667b8d05fd9d04e8c337b7ee121f37ef299aea6b3d82bdb3d3401950b4
  [tiny/decoder_kv.ort]=8852553f312adb6c9aa4d17418015049b30f412209ee569d336548c0044627de
  [tiny/streaming_config.json]=74fe5ddebd63b17caf59e8a3b18c17547ff7bce1642050edbb1c3962674f8950
  [tiny/tokenizer.bin]=6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d
  [small/frontend.model.ort]=09b1210ae30dc5f0f3e45f0ebab914c254741323114f53fbbe5ae62cca35058f
  [small/frontend.weights.ort]=7ef97521bd4bad3928f5bb6808586f4fcc6e92bd5990394112eed7d4052ec338
  [small/encoder.ort]=2d4d973e91e8aca08c51e7e7efa28a46ab265b63d809d5294d18b86bcd85b993
  [small/adapter.ort]=c665f742364febad597cc9ac1e0b341ffbee0e24a1466e2f3bde95e6e4771762
  [small/cross_kv.ort]=e2d3417144e9514055ebfefe8dcc4c0a55a55adcb8530435844c75c53e352bf6
  [small/decoder_kv.ort]=1a05465b1dd955858dfcbee039c0020fb5dd982b0f5094c34e61735d518d771b
  [small/streaming_config.json]=26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a
  [small/tokenizer.bin]=6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d
)
# Licences of the code linked into moonshine.dll (core/third-party is not MIT-only).
THIRD_PARTY=(Eigen/COPYING.MPL2 doctest/LICENSE.txt kaldi-native-fbank/LICENSE kissfft/COPYING
  nlohmann/LICENSE.MIT onnxruntime/LICENSE.txt utf-8/LICENSE.txt utf8proc/LICENSE.md)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

check_sha() { # file expected
  local got
  got=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$got" = "$2" ] || { echo "sha256 mismatch for $1: got $got, want $2" >&2; exit 1; }
}

fetch_runtime() {
  if [ -s "$RT_DEST/moonshine.dll" ] && [ -s "$RT_DEST/onnxruntime.dll" ]; then
    echo "runtime already in $RT_DEST"; return
  fi
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *)
    echo "skipping runtime: only Windows x64 is wired up (models still downloaded)"; return ;;
  esac
  # Find MSVC link.exe and the Windows SDK libs directly (vcvars from bash is unreliable).
  local vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
  [ -x "$vswhere" ] || { echo "need Visual Studio C++ build tools to link moonshine.dll" >&2; exit 1; }
  local vs ver msvc sdk
  vs=$(cygpath -u "$("$vswhere" -latest -products '*' \
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | tr -d '\r')")
  ver=$(tr -d '\r\n ' < "$vs/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt")
  msvc="$vs/VC/Tools/MSVC/$ver"
  sdk=$(ls -d "/c/Program Files (x86)/Windows Kits/10/Lib/"10.*/um/x64 2>/dev/null | sort -V | tail -1)
  [ -x "$msvc/bin/Hostx64/x64/link.exe" ] && [ -n "$sdk" ] ||
    { echo "MSVC x64 toolset or Windows SDK not found" >&2; exit 1; }
  sdk=${sdk%/um/x64}

  echo "downloading $RT_URL"
  curl -fL --retry 3 -o "$tmp/rt.tgz" "$RT_URL"
  check_sha "$tmp/rt.tgz" "$RT_SHA"
  tar -xzf "$tmp/rt.tgz" -C "$tmp"
  local lib="$tmp/$RT_NAME/lib"
  { echo "LIBRARY moonshine"; echo "EXPORTS"
    grep -oE 'MOONSHINE_EXPORT[^(]*\(' "$tmp/$RT_NAME/include/moonshine-c-api.h" |
      grep -oE 'moonshine_[a-z0-9_]+' | sort -u | sed 's/^/  /'; } > "$lib/moonshine.def"
  # LNK4001 (only libraries given, no objects) is expected.
  (cd "$lib" && LIB="$(cygpath -w "$msvc/lib/x64");$(cygpath -w "$sdk/ucrt/x64");$(cygpath -w "$sdk/um/x64")" \
    MSYS_NO_PATHCONV=1 "$msvc/bin/Hostx64/x64/link.exe" /nologo /DLL /MACHINE:X64 /OUT:moonshine.dll /IMPLIB:../dll-import.lib \
    /DEF:moonshine.def moonshine.lib bin-tokenizer.lib ort-utils.lib moonshine-utils.lib onnxruntime.lib \
    ole32.lib mmdevapi.lib) | iconv -f latin1 -t utf-8 | grep -v LNK4001 || true
  [ -s "$lib/moonshine.dll" ] || { echo "linking moonshine.dll failed" >&2; exit 1; }
  mv "$lib/moonshine.dll" "$tmp/moonshine.dll"

  mkdir -p "$RT_DEST/licenses"
  cp "$tmp/moonshine.dll" "$lib/onnxruntime.dll" "$tmp/$RT_NAME/include/moonshine-c-api.h" "$RT_DEST/"
  curl -fsSL --retry 3 -o "$RT_DEST/licenses/moonshine-LICENSE" "$RAW/LICENSE"
  for f in "${THIRD_PARTY[@]}"; do
    curl -fsSL --retry 3 -o "$RT_DEST/licenses/${f%%/*}-${f#*/}" "$RAW/core/third-party/$f"
  done
  echo "runtime ready in $RT_DEST ($(du -sh "$RT_DEST" | cut -f1))"
}

fetch_model() { # size
  local size=$1 dest="models/moonshine-$1" f url
  case "$size" in tiny|small|medium) ;; *) echo "unknown size $size (tiny|small|medium)" >&2; exit 1 ;; esac
  mkdir -p "$dest"
  for f in "${FILES[@]}"; do
    local want=${SHA[$size/$f]:-}
    if [ -s "$dest/$f" ] && { [ -z "$want" ] || [ "$(sha256sum "$dest/$f" | cut -d' ' -f1)" = "$want" ]; }; then
      continue
    fi
    url="$MODEL_BASE/$size-streaming-en/$MODEL_REV/$f"
    echo "downloading $url"
    curl -fL --retry 3 -o "$tmp/$f" "$url"
    if [ -n "$want" ]; then check_sha "$tmp/$f" "$want"; else echo "warning: no pinned sha256 for $size/$f" >&2; fi
    mv "$tmp/$f" "$dest/$f"
  done
  echo "model ready in $dest ($(du -sh "$dest" | cut -f1))"
}

fetch_runtime
[ $# -gt 0 ] || set -- small
for size in "$@"; do fetch_model "$size"; done
