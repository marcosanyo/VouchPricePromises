#!/usr/bin/env bash
# Generates product-category illustrations for the demo shop with Nano Banana
# 2.1 (scripts/visual.sh), one at a time, resized to 512px. No text or logos.
# Usage: scripts/gen-product-images.sh   (from the repository root)
set -uo pipefail
OUT=web/public/products
STYLE="Single product illustration, centered, flat vector style with soft shading, palette of deep navy #003087, bright blue #0070e0, light blue #e8f2fc and white, pure white background, no text, no letters, no logos, no brand marks, generic unbranded product, square composition."
gen() {
  for a in 1 2 3 4 5; do
    if scripts/visual.sh "$STYLE Subject: $1" "$OUT/$2.png"; then
      sips -Z 512 "$OUT/$2.png" >/dev/null
      return 0
    fi
    sleep 40
  done
  echo "FAILED $2"
}
gen "a generic home video game console with one controller" home-game-consoles
gen "a generic kitchen stand mixer with a steel bowl" stand-mixers
gen "a generic handheld percussive massage gun" massage-guns
gen "a generic wireless game controller accessory" video-game-console-accessories
gen "a pair of generic casual sneakers" sneakers
gen "a generic espresso machine with a portafilter" espresso-machines
