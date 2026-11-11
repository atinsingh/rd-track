#!/usr/bin/env bash
# Deploy the backend (API, worker, web) to an AWS environment from a workstation, with the same
# steps as .github/workflows/deploy.yml: build and push the two images to ECR, register the task
# definitions, run the migrate task, roll out the three services, smoke-check /healthz and /login.
#
# Use it when GitHub Actions can't run (no runners) or for the first deploy right after
# `terraform apply`. The pipeline stays the normal path; this script does not replace its
# approvals (production needs a v* tag on main, as in the pipeline).
#
# Needs: AWS credentials for the target account in the environment or a profile (AWS_PROFILE),
# docker with buildx, jq, curl, git. Run from the repository root:
#
#   AWS_REGION=ca-central-1 CLUSTER=rd-track-staging APP_HOST=staging.example.com scripts/deploy-local.sh
#
# CLUSTER and APP_HOST are `terraform output github_environment_variables` (NAME_PREFIX, APP_HOST).
set -euo pipefail

: "${AWS_REGION:?set AWS_REGION (e.g. ca-central-1)}"
: "${CLUSTER:?set CLUSTER (the NAME_PREFIX, e.g. rd-track-staging)}"
: "${APP_HOST:?set APP_HOST (e.g. staging.example.com)}"
# ECR repositories are <IMAGE_PREFIX>-api and <IMAGE_PREFIX>-web.
IMAGE_PREFIX="${IMAGE_PREFIX:-rd-track}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

for tool in aws docker jq curl git; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done
[ -z "$(git status --porcelain)" ] || { echo "the working tree has uncommitted changes: commit or stash them first" >&2; exit 1; }

SHA="$(git rev-parse HEAD)"
case "$CLUSTER" in
  *production*)
    tag="$(git describe --exact-match --tags --match 'v*' HEAD 2>/dev/null || true)"
    [ -n "$tag" ] || { echo "production deploys only from a v* tag (HEAD is not tagged)" >&2; exit 1; }
    git fetch -q --no-tags origin main
    git merge-base --is-ancestor "$SHA" origin/main || { echo "$SHA is not on main" >&2; exit 1; }
    ;;
esac

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
echo "Deploying $SHA to $CLUSTER (account $ACCOUNT, $AWS_REGION) as https://$APP_HOST"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

API_IMAGE="$REGISTRY/$IMAGE_PREFIX-api:$SHA"
WEB_IMAGE="$REGISTRY/$IMAGE_PREFIX-web:$SHA"
build() { # repo dockerfile image [build-arg]
  if aws ecr describe-images --repository-name "$1" --image-ids imageTag="$SHA" >/dev/null 2>&1; then
    echo "$1:$SHA exists, not rebuilding"; return
  fi
  docker buildx build --platform linux/amd64 --provenance=false -f "$2" -t "$3" ${4:+--build-arg "$4"} --push .
}
build "$IMAGE_PREFIX-api" apps/api/Dockerfile "$API_IMAGE"
build "$IMAGE_PREFIX-web" apps/web/Dockerfile "$WEB_IMAGE" "API_URL=https://$APP_HOST"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
register() { # family container image
  aws ecs describe-task-definition --task-definition "$1" --query taskDefinition --output json \
    | jq --arg c "$2" --arg img "$3" '
        .containerDefinitions |= map(if .name == $c then .image = $img else . end)
        | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, volumes,
           placementConstraints, requiresCompatibilities, cpu, memory, runtimePlatform,
           ephemeralStorage, pidMode, ipcMode, proxyConfiguration}
        | with_entries(select(.value != null))' > "$work/td-$2.json"
  aws ecs register-task-definition --cli-input-json "file://$work/td-$2.json" \
    --query taskDefinition.taskDefinitionArn --output text
}
TD_API=$(register "$CLUSTER-api" api "$API_IMAGE")
TD_WORKER=$(register "$CLUSTER-worker" worker "$API_IMAGE")
TD_WEB=$(register "$CLUSTER-web" web "$WEB_IMAGE")
TD_MIGRATE=$(register "$CLUSTER-migrate" migrate "$API_IMAGE")
printf 'api=%s\nworker=%s\nweb=%s\nmigrate=%s\n' "$TD_API" "$TD_WORKER" "$TD_WEB" "$TD_MIGRATE"

# Migrations: the worker's subnets and security group (the ones that may reach RDS).
netcfg=$(aws ecs describe-services --cluster "$CLUSTER" --services worker \
  --query 'services[0].networkConfiguration' --output json)
out=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$TD_MIGRATE" --network-configuration "$netcfg" \
  --started-by "local-$(whoami)" --output json)
task=$(jq -r '.tasks[0].taskArn // empty' <<<"$out")
[ -n "$task" ] || { echo "run-task failed: $(jq -c .failures <<<"$out")" >&2; exit 1; }
echo "migrate task: $task"
for _ in 1 2 3; do aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task" && break; done
desc=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --output json)
status=$(jq -r '.tasks[0].lastStatus' <<<"$desc")
code=$(jq -r '.tasks[0].containers[] | select(.name == "migrate") | .exitCode // "none"' <<<"$desc")
aws logs get-log-events --log-group-name "/ecs/$CLUSTER/migrate" \
  --log-stream-name "migrate/migrate/${task##*/}" --start-from-head \
  --query 'events[].message' --output text | tr '\t' '\n' || true
if [ "$status" != STOPPED ]; then
  aws ecs stop-task --cluster "$CLUSTER" --task "$task" --reason "deploy timeout" >/dev/null || true
  echo "migration did not finish in time" >&2; exit 1
fi
[ "$code" = 0 ] || { echo "migration failed (exit $code): $(jq -r '.tasks[0].stoppedReason // ""' <<<"$desc")" >&2; exit 1; }
echo "Migrations applied"

td() { case "$1" in api) echo "$TD_API" ;; worker) echo "$TD_WORKER" ;; web) echo "$TD_WEB" ;; esac; } # bash 3.2 (macOS): no associative arrays
for svc in api worker web; do
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" --task-definition "$(td "$svc")" \
    --query 'service.serviceName' --output text
done
# The PRIMARY deployment, not `wait services-stable`: a circuit-breaker rollback also ends stable.
pending=(api worker web); deadline=$((SECONDS + 1800))
while [ ${#pending[@]} -gt 0 ]; do
  [ $SECONDS -lt $deadline ] || { echo "timed out waiting for: ${pending[*]}" >&2; exit 1; }
  sleep 15
  still=()
  for svc in "${pending[@]}"; do
    read -r cur state reason < <(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" \
      --query 'services[0].deployments[?status==`PRIMARY`] | [0].[taskDefinition, rolloutState, rolloutStateReason]' \
      --output text)
    [ "$cur" = "$(td "$svc")" ] || { echo "$svc rolled back (primary is $cur): $reason" >&2; exit 1; }
    case "$state" in
      COMPLETED) echo "$svc: rolled out" ;;
      FAILED) echo "$svc deployment failed: $reason" >&2; exit 1 ;;
      *) still+=("$svc") ;;
    esac
  done
  pending=("${still[@]+"${still[@]}"}")
done

for i in $(seq 1 12); do
  body=$(curl -fsS --max-time 10 "https://$APP_HOST/healthz" || true)
  grep -q '"ok":true' <<<"$body" && { echo "healthz: $body"; break; }
  [ "$i" = 12 ] && { echo "https://$APP_HOST/healthz not healthy: $body" >&2; exit 1; }
  sleep 10
done
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$APP_HOST/login")
[ "$code" = 200 ] || { echo "https://$APP_HOST/login returned $code" >&2; exit 1; }
echo "Deployed $SHA: https://$APP_HOST"
