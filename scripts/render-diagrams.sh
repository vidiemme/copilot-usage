#!/usr/bin/env bash
# Rende i diagrammi HTML in PNG a 2x, accanto al sorgente.
#
#   scripts/render-diagrams.sh packages/client/docs/diagrams/*.html
#
# Si fotografa solo l'SVG: padding e footer della pagina vengono nascosti e la
# finestra prende le dimensioni del viewBox. I font arrivano da Google Fonts,
# quindi serve la rete.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "$CHROME" ]; then
  echo "Chrome non trovato in \"$CHROME\": impostalo con CHROME=/percorso/del/binario" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for src in "$@"; do
  abs="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
  size=$(grep -oE 'viewBox="0 0 [0-9]+ [0-9]+"' "$abs" | head -1 | grep -oE '[0-9]+ [0-9]+"' | tr -d '"')
  width=${size% *}
  height=${size#* }
  page="$tmp/$(basename "$abs")"
  sed 's#</head>#<style>body{padding:0!important}footer{display:none}.frame{width:'"$width"'px!important}svg{min-width:0!important}</style></head>#' "$abs" > "$page"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size="$width,$height" --virtual-time-budget=4000 \
    --screenshot="${abs%.html}.png" "file://$page" >/dev/null 2>&1
  echo "${abs%.html}.png (${width}x${height} @2x)"
done
