#!/usr/bin/env bash
#
# Deploy the catalogue service to floci.
#
# This is a wrapper around Terraform, not a second implementation. The shell's
# job is the two things Terraform cannot do - build the image and run the
# verification checks - plus the small amount of input plumbing that would
# otherwise be typed by hand on every apply.
#
#   ./deploy/deploy.sh              build the image, then apply
#   ./deploy/deploy.sh --plan       same, but stop at the plan
#   ./deploy/deploy.sh --no-build   apply without rebuilding the image
#   ./deploy/deploy.sh --destroy    remove everything Terraform created
#
# Inputs come from the environment or from mohamed/.env.neon:
#   DATABASE_URL   required, the Neon connection string
#   AWS_PROFILE    default floci
#   TF             path to terraform, if it is not on PATH
#
# Nothing here creates a database. The schema and the first admin are
# deliberate, one-off steps (scripts/apply-schema.mjs, scripts/seed-admin.mjs).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

REGION="${REGION:-us-east-1}"
ACCOUNT="${ACCOUNT:-000000000000}"
REPOSITORY="${REPOSITORY:-class-tt/catalogue}"
TAG="${TAG:-deploy}"
IMAGE="$ACCOUNT.dkr.ecr.$REGION.localhost:4566/$REPOSITORY:$TAG"
PUBLIC_URL="${PUBLIC_URL:-https://localhost:8443}"

# Git Bash rewrites arguments that look like paths, which breaks -var values.
export MSYS_NO_PATHCONV=1
export AWS_PROFILE="${AWS_PROFILE:-floci}"

MODE="apply"
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --plan)     MODE="plan" ;;
    --destroy)  MODE="destroy" ;;
    --no-build) BUILD=0 ;;
    -h|--help)  sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)          echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

note() { printf '\n== %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------

command -v docker >/dev/null || fail "docker is not on PATH"
command -v curl   >/dev/null || fail "curl is not on PATH"

TF="${TF:-}"
if [[ -z "$TF" ]]; then
  if command -v terraform >/dev/null; then
    TF="terraform"
  elif [[ -x "${LOCALAPPDATA:-/nonexistent}/terraform/terraform.exe" ]]; then
    TF="$LOCALAPPDATA/terraform/terraform.exe"
  else
    fail "terraform is not on PATH and TF is not set"
  fi
fi

# DATABASE_URL: environment first, then .env.neon, which is gitignored.
DATABASE_URL="${DATABASE_URL:-}"
if [[ -z "$DATABASE_URL" && -f "$ROOT_DIR/.env.neon" ]]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ROOT_DIR/.env.neon" | head -n 1)"
fi
[[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL is not set and .env.neon has no DATABASE_URL"

note "terraform  $("$TF" version | head -n 1)"
note "image      $IMAGE"
note "endpoint   floci on 127.0.0.1:4566, public URL $PUBLIC_URL"

# --- image -------------------------------------------------------------------

if [[ "$BUILD" == "1" && "$MODE" != "destroy" ]]; then
  note "building the image as $IMAGE"
  # MSYS_NO_PATHCONV is on for Terraform, so the build context is converted by
# hand: docker on Windows does not understand /c/Users/...
CONTEXT="$ROOT_DIR"
if command -v cygpath >/dev/null 2>&1; then
  CONTEXT="$(cygpath -m "$ROOT_DIR")"
fi
docker build -q -t "$IMAGE" "$CONTEXT" >/dev/null
  # Same tag without the registry prefix, so `docker images` stays readable.
  docker tag "$IMAGE" "$REPOSITORY:$TAG"
fi

# --- terraform ---------------------------------------------------------------

# The listener needs a certificate. Generated once, gitignored, self-signed.
if [[ ! -f "$INFRA_DIR/tls/dev.crt" || ! -f "$INFRA_DIR/tls/dev.key" ]]; then
  note "creating the self-signed certificate"
  bash "$ROOT_DIR/scripts/make-dev-cert.sh" >&2
fi

cd "$INFRA_DIR"

if [[ ! -d .terraform ]]; then
  note "terraform init"
  "$TF" init -input=false -no-color
fi

VARS=(-var "database_url=$DATABASE_URL" -var "image=$IMAGE")

case "$MODE" in
  plan)
    note "terraform plan"
    "$TF" plan -input=false -no-color "${VARS[@]}"
    exit 0
    ;;
  destroy)
    note "terraform destroy"
    "$TF" destroy -input=false -auto-approve -no-color "${VARS[@]}"
    note "the KMS key, the sealed signing key and the Neon database were not created here, so they remain"
    exit 0
    ;;
  apply)
    note "terraform apply"
    "$TF" apply -input=false -auto-approve -no-color "${VARS[@]}" >/tmp/class-tt-apply.log 2>&1 ||
      { tail -n 40 /tmp/class-tt-apply.log >&2; fail "terraform apply failed (full log in /tmp/class-tt-apply.log)"; }
    tail -n 8 /tmp/class-tt-apply.log >&2
    ;;
esac

# --- rollout -----------------------------------------------------------------

# A task reads its secrets once, at start. If only a secret value changed, the
# task definition is identical, Terraform sees nothing to do, and the running
# task keeps the old value. So the script forces one rollout and waits for it.
if [[ "$MODE" == "apply" ]]; then
  CLUSTER="$("$TF" output -raw cluster 2>/dev/null || true)"
  SERVICE="$("$TF" output -raw service 2>/dev/null || true)"

  if [[ -n "$CLUSTER" && -n "$SERVICE" ]] && command -v aws >/dev/null; then
    note "forcing a new deployment so the task picks up the current secrets"
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
      --force-new-deployment --output text >/dev/null 2>&1 ||
      fail "could not force a new deployment (is AWS_PROFILE=floci set up?)"

    for _ in $(seq 1 30); do
      read -r state running < <(aws ecs describe-services --cluster "$CLUSTER" \
        --services "$SERVICE" \
        --query 'services[0].deployments[0].[rolloutState,runningCount]' --output text 2>/dev/null || echo "NONE 0")
      [[ "$state" == "COMPLETED" && "$running" == "1" ]] && break
      sleep 4
    done
    note "rollout $state, $running task running"
  else
    note "aws CLI or the cluster output is missing, so the rollout is left to ECS"
  fi
fi

# --- verification ------------------------------------------------------------

# The task needs a moment to pass its health check before the target is healthy.
note "waiting for the service to settle"
for _ in $(seq 1 30); do
  status="$(curl -sk -o /dev/null -w '%{http_code}' "$PUBLIC_URL/" || true)"
  [[ "$status" == "200" ]] && break
  sleep 4
done

check() {
  local path="$1" expected="$2"
  local got
  got="$(curl -sk -o /dev/null -w '%{http_code}' "$PUBLIC_URL$path" || true)"
  if [[ "$got" == "$expected" ]]; then
    printf '  %-16s %s\n' "$path" "$got"
  else
    printf '  %-16s %s (expected %s)\n' "$path" "$got" "$expected" >&2
    FAILED=1
  fi
}

note "checks against $PUBLIC_URL"
FAILED=0
check "/"            200
check "/readyz"      404
check "/healthz"     404
check "/api/courses" 401

if [[ "$FAILED" == "1" ]]; then
  note "open /readyz failures are usually the database: check the task logs"
  "$TF" output -no-color 2>/dev/null | sed 's/^/  /' >&2 || true
  exit 1
fi

note "done"
"$TF" output -no-color
