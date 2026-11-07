#!/usr/bin/env bash
# Deploy Vouch to Cloud Run (one service: API, MCP-over-HTTP routes, web app).
#   scripts/deploy.sh secrets   copy the API keys from .env into Secret Manager (values are never printed)
#   scripts/deploy.sh deploy    refresh the DB snapshot, build the image, push it, deploy the service
# The image carries a snapshot of the local database; only the local Mac writes the real one.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=$(grep '^GOOGLE_CLOUD_PROJECT=' .env | cut -d= -f2-)
REGION=us-central1
SERVICE=vouch
SA="vouch-run@${PROJECT}.iam.gserviceaccount.com"
REPO="${REGION}-docker.pkg.dev/${PROJECT}/vouch"
# DEMO_PASSWORD (the password login; user "judge") comes from CLOUD_RUN_DEMO_PASSWORD in .env,
# which the local server does not read, so nothing asks for it locally.
SECRETS=(PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_SELLER_2_CLIENT_ID PAYPAL_SELLER_2_CLIENT_SECRET PAYPAL_SELLER_3_CLIENT_ID PAYPAL_SELLER_3_CLIENT_SECRET CHANNEL3_API_KEY DEMO_PASSWORD)
secret_name() { echo "vouch-$(echo "$1" | tr 'A-Z_' 'a-z-')"; }
env_value() { local v=$1; [ "$v" = DEMO_PASSWORD ] && v=CLOUD_RUN_DEMO_PASSWORD; grep "^$v=" .env | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

case "${1:-}" in
secrets)
  for v in "${SECRETS[@]}"; do
    name=$(secret_name "$v")
    val=$(env_value "$v")
    [ -n "$val" ] || { echo "$v is empty in .env" >&2; exit 1; }
    if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
      printf %s "$val" | gcloud secrets versions add "$name" --project "$PROJECT" --data-file=- >/dev/null
    else
      printf %s "$val" | gcloud secrets create "$name" --project "$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
    fi
    echo "stored $name"
  done
  # Runtime service account: Vertex AI (Gemini 3.8 Flash) and read access to these secrets only.
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud iam service-accounts create vouch-run --project "$PROJECT" --display-name "Vouch Cloud Run"
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role roles/aiplatform.user --condition=None >/dev/null
  for v in "${SECRETS[@]}"; do
    gcloud secrets add-iam-policy-binding "$(secret_name "$v")" --project "$PROJECT" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  done
  echo "service account $SA ready"
  ;;
deploy)
  npm -w server run snapshot
  gcloud artifacts repositories describe vouch --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 \
    || gcloud artifacts repositories create vouch --project "$PROJECT" --location "$REGION" --repository-format docker
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null
  tag="${REPO}/vouch:$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"
  docker build --platform linux/amd64 -t "$tag" .
  docker push "$tag"
  set_secrets=$(for v in "${SECRETS[@]}"; do printf '%s=%s:latest,' "$v" "$(secret_name "$v")"; done)
  # Anyone can reach the URL, but every page and API call needs the password (DEMO_PASSWORD).
  # One instance: the database is a file inside it, and the daily caps are counted in memory.
  # No CPU throttling: shopping tasks keep running after the request that started them returns.
  # One instance always up until judging ends (2026-12-15, user's decision): no cold start for judges.
  # After that, change --min-instances to 0 (and run: gcloud run services update vouch --region us-central1 --min-instances 0).
  gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --image "$tag" \
    --service-account "$SA" --allow-unauthenticated \
    --min-instances 1 --max-instances 1 --memory 1Gi --cpu 1 --timeout 600 --no-cpu-throttling \
    --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=$(env_value GOOGLE_CLOUD_LOCATION),GEMINI_MODEL_ID=$(env_value GEMINI_MODEL_ID),PAYPAL_API_BASE=$(env_value PAYPAL_API_BASE)" \
    --set-secrets "${set_secrets%,}"
  gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'
  ;;
*)
  echo "usage: scripts/deploy.sh secrets|deploy" >&2
  exit 2
  ;;
esac
