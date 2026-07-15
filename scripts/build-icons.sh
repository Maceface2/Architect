#!/usr/bin/env bash
# Build resources/icon.png and resources/icon.icns from resources/clique-logo.svg.
# Uses macOS-bundled tools only (qlmanage + sips + iconutil), no extra deps.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=resources/clique-logo.svg
OUT_PNG=resources/icon.png
OUT_ICNS=resources/icon.icns

if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

# Wrap the source logo in a 1024x1024 canvas with a rounded-rect background
# tile so the icon reads as a proper app icon at every macOS rendered size.
# The clique sits at ~80% of the canvas: scale 4.0 from 200 → 800, offset 112.
cat > "$TMP/icon-1024.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#221f1b"/>
      <stop offset="1" stop-color="#141210"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" fill="url(#bg)"/>
  <g transform="translate(112, 112) scale(4)" stroke="#ebe7e1" stroke-width="6" stroke-linecap="round" fill="none">
    <line x1="50"  y1="50"  x2="150" y2="50"/>
    <line x1="150" y1="50"  x2="150" y2="150"/>
    <line x1="150" y1="150" x2="50"  y2="150"/>
    <line x1="50"  y1="150" x2="50"  y2="50"/>
    <line x1="50"  y1="50"  x2="150" y2="150"/>
    <line x1="150" y1="50"  x2="50"  y2="150"/>
  </g>
  <g transform="translate(112, 112) scale(4)">
    <circle cx="50"  cy="50"  r="13" fill="#ebe7e1"/>
    <circle cx="150" cy="50"  r="13" fill="#E2B237"/>
    <circle cx="150" cy="150" r="13" fill="#ebe7e1"/>
    <circle cx="50"  cy="150" r="13" fill="#ebe7e1"/>
  </g>
</svg>
SVG

# Rasterize the wrapper SVG to 1024x1024 PNG via Quick Look. qlmanage writes
# <input>.png next to the requested output directory.
qlmanage -t -s 1024 -o "$TMP" "$TMP/icon-1024.svg" >/dev/null
cp "$TMP/icon-1024.svg.png" "$OUT_PNG"

# Build an iconset for iconutil. macOS needs these exact sizes & filenames.
ICONSET="$TMP/clique.iconset"
mkdir -p "$ICONSET"
for SZ in 16 32 64 128 256 512 1024; do
  sips -z "$SZ" "$SZ" "$OUT_PNG" --out "$TMP/icon_${SZ}x${SZ}.png" >/dev/null
done
cp "$TMP/icon_16x16.png"   "$ICONSET/icon_16x16.png"
cp "$TMP/icon_32x32.png"   "$ICONSET/icon_16x16@2x.png"
cp "$TMP/icon_32x32.png"   "$ICONSET/icon_32x32.png"
cp "$TMP/icon_64x64.png"   "$ICONSET/icon_32x32@2x.png"
cp "$TMP/icon_128x128.png" "$ICONSET/icon_128x128.png"
cp "$TMP/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
cp "$TMP/icon_256x256.png" "$ICONSET/icon_256x256.png"
cp "$TMP/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
cp "$TMP/icon_512x512.png" "$ICONSET/icon_512x512.png"
cp "$TMP/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$OUT_ICNS"

# Resize the runtime PNG to 512x512 (electron-builder uses this for win/linux).
sips -z 512 512 "$OUT_PNG" --out "$OUT_PNG" >/dev/null

echo "wrote $OUT_PNG and $OUT_ICNS"
