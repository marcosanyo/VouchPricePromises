#!/usr/bin/env bash
# Generate an explanatory image with Nano Banana 2.1 on Vertex AI.
# Usage: scripts/visual.sh "<prompt>" [output.png] [reference.png]
# With a reference image the prompt is an edit instruction applied to that image.
# Prints the output path. Fails with the raw API error (no fallback).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Read only the variables this script needs. Sourcing the whole .env breaks
# when another value (e.g. a secret) contains quotes or shell characters.
envval() { grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-$(envval GOOGLE_CLOUD_PROJECT)}"
GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-$(envval GOOGLE_CLOUD_LOCATION)}"
IMAGE_MODEL_ID="${IMAGE_MODEL_ID:-$(envval IMAGE_MODEL_ID)}"

PROMPT="${1:?usage: scripts/visual.sh \"<prompt>\" [output.png]}"
OUT="${2:-$ROOT/.visuals/$(date +%Y%m%d_%H%M%S).png}"
: "${GOOGLE_CLOUD_PROJECT:?}" "${IMAGE_MODEL_ID:?}"
LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"
HOST="aiplatform.googleapis.com"
[ "$LOCATION" = "global" ] || HOST="${LOCATION}-aiplatform.googleapis.com"

TOKEN="$(gcloud auth application-default print-access-token)"
RESP="$(mktemp)"; trap 'rm -f "$RESP"' EXIT
mkdir -p "$(dirname "$OUT")"

REF="${3:-}"
BODY="$(mktemp)"; trap 'rm -f "$RESP" "$BODY"' EXIT
if [ -n "$REF" ]; then
  base64 -i "$REF" | tr -d '\n' > "$BODY.b64"
  jq -n --arg p "$PROMPT" --rawfile img "$BODY.b64" \
    '{contents:[{role:"user",parts:[{inlineData:{mimeType:"image/png",data:$img}},{text:$p}]}],generationConfig:{responseModalities:["IMAGE"]}}' > "$BODY"
  rm -f "$BODY.b64"
else
  jq -n --arg p "$PROMPT" \
    '{contents:[{role:"user",parts:[{text:$p}]}],generationConfig:{responseModalities:["IMAGE"]}}' > "$BODY"
fi

HTTP=$(
  curl -s -w '%{http_code}' -o "$RESP" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "https://${HOST}/v1/projects/${GOOGLE_CLOUD_PROJECT}/locations/${LOCATION}/publishers/google/models/${IMAGE_MODEL_ID}:generateContent" \
    -d @"$BODY")

if [ "$HTTP" != "200" ]; then
  echo "Vertex AI ${IMAGE_MODEL_ID} failed: HTTP ${HTTP}" >&2
  cat "$RESP" >&2
  exit 1
fi

DATA=$(jq -r '[.candidates[0].content.parts[]? | select(.inlineData) | .inlineData.data][0] // empty' "$RESP")
if [ -z "$DATA" ]; then
  echo "Vertex AI ${IMAGE_MODEL_ID} returned no image:" >&2
  cat "$RESP" >&2
  exit 1
fi
printf '%s' "$DATA" | base64 -D > "$OUT"
echo "$OUT"
