#!/usr/bin/env bash
# Connects the existing Compare & Share Lambda function to an API Gateway
# HTTP API (v2) on LOCAL Floci only.
#
#   bash scripts/deploy-floci-apigateway.sh        (from the mohab folder)
#
# Needs: Floci on 127.0.0.1:4566 and the function deployed with
# scripts/deploy-floci-lambda.sh.
#
# Safety: only a loopback endpoint is accepted, Floci's dummy credentials are
# forced (never your AWS profile) and the script stops unless the account is
# Floci's 000000000000. Re-running reuses the existing API, integration, routes
# and stage, so nothing is duplicated. Nothing is ever deleted.
#
# Security note: API Gateway only forwards requests. Login (JWT) and ownership
# checks stay inside the application, which is the real security boundary.
set -euo pipefail

FLOCI_ENDPOINT="${FLOCI_ENDPOINT:-http://127.0.0.1:4566}"
REGION="us-east-1"
ACCOUNT_ID="000000000000"
API_NAME="class-tt-compare-share-api"
FUNCTION_NAME="class-tt-compare-share"
STATEMENT_ID="class-tt-compare-share-api-invoke"
# Exactly the endpoints of the service; nothing else reaches the function.
ROUTES=(
  "POST /api/compare"
  "POST /api/shares"
  "GET /api/shares"
  "GET /api/shares/{token}"
  "DELETE /api/shares/{token}"
  "GET /api/shares/{token}/calendar.ics"
)

# --- guard: local emulator only ---------------------------------------------
if [[ ! "$FLOCI_ENDPOINT" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]; then
  echo "Refusing: FLOCI_ENDPOINT must be a local address (http://127.0.0.1:<port>), got $FLOCI_ENDPOINT" >&2
  exit 1
fi
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_PAGER=""

awsl() {
  # stdin closed and pager off: the AWS CLI otherwise hangs on this Windows setup.
  aws --endpoint-url "$FLOCI_ENDPOINT" --region "$REGION" --no-cli-pager --output text "$@" < /dev/null
}

ACCOUNT="$(awsl sts get-caller-identity --query Account)"
if [[ "$ACCOUNT" != "$ACCOUNT_ID" ]]; then
  echo "Refusing: account is $ACCOUNT, not Floci's $ACCOUNT_ID" >&2
  exit 1
fi

FUNCTION_ARN="$(awsl lambda get-function --function-name "$FUNCTION_NAME" --query Configuration.FunctionArn)" || {
  echo "Function $FUNCTION_NAME not found. Run scripts/deploy-floci-lambda.sh first." >&2
  exit 1
}

# --- API (reuse by name) ------------------------------------------------------
API_ID="$(awsl apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]")"
if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  API_ID="$(awsl apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId)"
  echo "created API $API_NAME ($API_ID)"
else
  echo "reusing API $API_NAME ($API_ID)"
fi

# --- integration (reuse the one pointing at our function) ---------------------
INTEGRATION_ID="$(awsl apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$FUNCTION_ARN'].IntegrationId | [0]")"
if [[ -z "$INTEGRATION_ID" || "$INTEGRATION_ID" == "None" ]]; then
  INTEGRATION_ID="$(awsl apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --integration-uri "$FUNCTION_ARN" \
    --payload-format-version 2.0 --timeout-in-millis 15000 --query IntegrationId)"
  echo "created integration $INTEGRATION_ID"
fi

# --- routes (create only the missing ones) -----------------------------------
EXISTING_ROUTES="$(awsl apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' | tr '\t' '\n')"
for ROUTE in "${ROUTES[@]}"; do
  if grep -Fxq "$ROUTE" <<< "$EXISTING_ROUTES"; then
    echo "route exists: $ROUTE"
  else
    awsl apigatewayv2 create-route --api-id "$API_ID" --route-key "$ROUTE" \
      --target "integrations/$INTEGRATION_ID" >/dev/null
    echo "created route: $ROUTE"
  fi
done

# --- $default stage with auto-deploy (no stage name in the URL path) ---------
if ! awsl apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1; then
  awsl apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy >/dev/null
  echo 'created stage $default'
fi

# --- throttling on the stage (applies to every route) ------------------------
# Steady rate of 20 requests/second with bursts up to 40; extra requests get
# HTTP 429. Re-running only sets the same values again.
# Note: Floci 2.5.0 stores these settings but does not enforce them (tested;
# see deploy/README.md). Real API Gateway enforces them.
awsl apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
  --default-route-settings ThrottlingBurstLimit=40,ThrottlingRateLimit=20 >/dev/null
echo 'stage $default throttling: rate 20/s, burst 40'

# --- permission for API Gateway to invoke the function (only this API) -------
# Floci does not check this for HTTP APIs yet, but real AWS requires it.
if ! awsl lambda get-policy --function-name "$FUNCTION_NAME" 2>/dev/null | grep -q "$STATEMENT_ID"; then
  awsl lambda add-permission --function-name "$FUNCTION_NAME" \
    --statement-id "$STATEMENT_ID" --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/*/api/*" >/dev/null
  echo "added invoke permission for API $API_ID"
fi

echo "API_URL=http://$API_ID.execute-api.localhost.floci.io:4566"
