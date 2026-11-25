#!/usr/bin/env bash
# CloudWatch logging and monitoring on LOCAL Floci: the Compare & Share Lambda,
# plus team-wide metrics, alarms and one shared dashboard for all three services.
#
#   bash scripts/deploy-floci-monitoring.sh        (from the mohab folder)
#
# Floci 2.5.0 does not publish AWS/Lambda metrics, so monitoring is built from
# the function's own structured logs (requestLogger.js) with log-based metric
# filters, plus alarms on those metrics.
#
# Safety: only a loopback endpoint is accepted, Floci's dummy credentials are
# forced and the script stops unless the account is 000000000000. All calls are
# create-or-update ("put"), so re-running never duplicates anything, and nothing
# is ever deleted.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # keep "/aws/lambda/..." as-is in Git Bash

FLOCI_ENDPOINT="${FLOCI_ENDPOINT:-http://127.0.0.1:4566}"
REGION="us-east-1"
LOG_GROUP="/aws/lambda/class-tt-compare-share"
NAMESPACE="ClassTT/CompareShare"
RETENTION_DAYS=14

if [[ ! "$FLOCI_ENDPOINT" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]; then
  echo "Refusing: FLOCI_ENDPOINT must be a local address (http://127.0.0.1:<port>), got $FLOCI_ENDPOINT" >&2
  exit 1
fi
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_PAGER=""
awsl() { aws --endpoint-url "$FLOCI_ENDPOINT" --region "$REGION" --no-cli-pager --output text "$@" < /dev/null; }

[[ "$(awsl sts get-caller-identity --query Account)" == "000000000000" ]] || { echo "Refusing: not Floci's account" >&2; exit 1; }

# The log group is created by Lambda on first use; create it if it is missing.
if [[ "$(awsl logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query "logGroups[?logGroupName=='$LOG_GROUP'] | length(@)")" == "0" ]]; then
  awsl logs create-log-group --log-group-name "$LOG_GROUP"
  echo "created log group $LOG_GROUP"
fi
awsl logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days "$RETENTION_DAYS"
echo "retention $RETENTION_DAYS days on $LOG_GROUP"

# name | filter pattern | metric value
put_filter() {
  awsl logs put-metric-filter --log-group-name "$LOG_GROUP" --filter-name "$1" --filter-pattern "$2" \
    --metric-transformations "metricName=$1,metricNamespace=$NAMESPACE,metricValue=$3"
  echo "metric filter $1"
}
put_filter Requests            '{ $.event = "http.request" }'                       1
put_filter ServerErrors        '{ $.event = "http.request" && $.status >= 500 }'    1
put_filter AuthFailures        '{ $.event = "http.request" && $.status = 401 }'     1
put_filter DependencyFailures  '{ $.event = "http.request" && $.outcome = "dependency_failure" }' 1
put_filter LatencyMs           '{ $.event = "http.request" }'                       '$.durationMs'
# Crashes of the function itself (the Node runtime's "Invoke Error" line), kept
# separate from HTTP 5xx responses that the function returned normally.
put_filter LambdaInvocationErrors '"Invoke Error"'                                  1

# name | metric | threshold | period seconds
put_alarm() {
  awsl cloudwatch put-metric-alarm --alarm-name "$1" --namespace "$NAMESPACE" --metric-name "$2" \
    --statistic Sum --period "$4" --evaluation-periods 1 --threshold "$3" \
    --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
    --alarm-description "$5"
  echo "alarm $1"
}
put_alarm class-tt-compare-share-5xx               ServerErrors           1 60  "Any HTTP 5xx answered by Compare & Share in one minute"
put_alarm class-tt-compare-share-auth-failures     AuthFailures           5 300 "5 or more 401 responses in 5 minutes (possible token guessing)"
put_alarm class-tt-compare-share-invocation-errors LambdaInvocationErrors 1 60  "The Lambda function itself failed (not an HTTP error response)"

# ---------------------------------------------------------------------------
# Team-wide monitoring (Timetable service) and the shared dashboard.
#
# Catalogue & Accounts: its metrics and alarms are defined by Mohamed's own
# Terraform (mohamed/infra/main.tf, namespace ClassTT/Catalogue on the log group
# /class-tt/catalogue, alarms class-tt-catalogue-*). They are NOT recreated here,
# so nothing is counted twice; the shared dashboard only displays them.
#
# Timetable: built only from the log lines Yehia's service ALREADY writes;
# nothing in his code or logging is changed. Filters and alarms use the
# "class-tt-team-" prefix and their own namespace, so they never replace a
# teammate's resources. His log group is never created here (his setup script
# owns it); if it does not exist yet, that part is skipped with a message.
#
#   Timetable  /timetable-service/app  (Yehia's logger, PutLogEvents)
#     line: {"timestamp","service":"timetable-service","level","event",...}
#     events used: INTERNAL_ERROR, AUTH_MISSING_TOKEN, AUTH_INVALID_TOKEN
# ---------------------------------------------------------------------------
TIMETABLE_GROUP="/timetable-service/app"
group_exists() {
  [[ "$(awsl logs describe-log-groups --log-group-name-prefix "$1" --query "logGroups[?logGroupName=='$1'] | length(@)")" != "0" ]]
}
# group | namespace | name | pattern | value
put_team_filter() {
  awsl logs put-metric-filter --log-group-name "$1" --filter-name "class-tt-team-$3" --filter-pattern "$4" \
    --metric-transformations "metricName=$3,metricNamespace=$2,metricValue=$5"
  echo "metric filter class-tt-team-$3 on $1"
}
# name | namespace | metric | threshold | period | description
put_team_alarm() {
  awsl cloudwatch put-metric-alarm --alarm-name "$1" --namespace "$2" --metric-name "$3" \
    --statistic Sum --period "$5" --evaluation-periods 1 --threshold "$4" \
    --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
    --alarm-description "$6"
  echo "alarm $1"
}

if group_exists "$TIMETABLE_GROUP"; then
  NS="ClassTT/Timetable"
  put_team_filter "$TIMETABLE_GROUP" "$NS" TimetableServerErrors '{ $.event = "INTERNAL_ERROR" }' 1
  put_team_filter "$TIMETABLE_GROUP" "$NS" TimetableAuthFailures '{ $.event = "AUTH_INVALID_TOKEN" || $.event = "AUTH_MISSING_TOKEN" }' 1
  put_team_alarm class-tt-team-timetable-5xx "$NS" TimetableServerErrors 1 60 "Any unexpected server error in the Timetable Service in one minute"
else
  echo "skipped Timetable monitoring: $TIMETABLE_GROUP does not exist yet (created by Yehia's setup script)"
fi

# One shared dashboard for all three services (create-or-update by name).
DASHBOARD_FILE="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))/deploy/monitoring-dashboard.json"
awsl cloudwatch put-dashboard --dashboard-name class-tt-team-monitoring --dashboard-body "file://$DASHBOARD_FILE" >/dev/null
echo "dashboard class-tt-team-monitoring"

awsl cloudwatch describe-alarms --alarm-name-prefix class-tt- --query 'MetricAlarms[].[AlarmName,StateValue]'
