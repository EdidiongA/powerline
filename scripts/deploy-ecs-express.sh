#!/usr/bin/env bash
# One-shot deploy of Powerline to Amazon ECS Express Mode: a public HTTPS URL on Fargate, no load
# balancer or VPC work to do by hand. Runs anywhere the AWS CLI is signed in — AWS CloudShell in the
# console is the easiest place (no local install, no keys).
#
#   API_TOKEN_SECRET=$(openssl rand -hex 24) bash scripts/deploy-ecs-express.sh
#
# Prints the live /demo URL and the judge token. The image comes from GitHub's registry, published
# by .github/workflows/image.yml on every push to main (make the package public once: GitHub →
# your profile → Packages → powerline → Package settings → Change visibility → Public).
#
# Optional:  IMAGE=ghcr.io/<you>/powerline:latest  SERVICE=powerline  AWS_REGION=us-east-1
#            STORE=dynamodb DYNAMO_TABLE=powerline BEDROCK_MODEL_ID=…  (then TASK_ROLE_ARN=… with
#            DynamoDB + Bedrock access)   POWER_SOURCE=victron VRM_DEMO=1
#
#   bash scripts/deploy-ecs-express.sh delete      # tears the service down again
set -euo pipefail
REGION=${AWS_REGION:-us-east-1}
SERVICE=${SERVICE:-powerline}
IMAGE=${IMAGE:-ghcr.io/edidionga/powerline:latest}
API_TOKEN_SECRET=${API_TOKEN_SECRET:-}
TASK_ROLE_ARN=${TASK_ROLE_ARN:-}
export AWS_PAGER=""

acct=$(aws sts get-caller-identity --query Account --output text)
find_service() {
  aws ecs list-services --region "$REGION" --query 'serviceArns' --output text 2>/dev/null | tr '\t' '\n' | grep "/${SERVICE}\$" || true
}

if [[ "${1:-}" == "delete" ]]; then
  arn=$(find_service)
  [[ -z "$arn" ]] && { echo "no service named $SERVICE in $REGION"; exit 0; }
  aws ecs delete-express-gateway-service --region "$REGION" --service-arn "$arn" --monitor-resources --monitor-mode TEXT-ONLY >/dev/null
  echo "deleting $arn (takes a few minutes; also removes the load balancer it created)"; exit 0
fi

# ---- the two roles Express Mode needs (idempotent) ----
role_arn() {
  local name=$1 principal=$2 policy=$3
  if ! aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    aws iam create-role --role-name "$name" --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"$principal\"},\"Action\":\"sts:AssumeRole\"}]}" >/dev/null
    aws iam attach-role-policy --role-name "$name" --policy-arn "$policy"
    echo "created IAM role $name" >&2; sleep 12   # IAM is eventually consistent
  fi
  aws iam get-role --role-name "$name" --query Role.Arn --output text
}
exec_role=$(role_arn ecsTaskExecutionRole ecs-tasks.amazonaws.com arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy)
infra_role=$(role_arn ecsInfrastructureRoleForExpressServices ecs.amazonaws.com arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices)

# ---- a default VPC must exist (fresh accounts have one; this restores it if it was deleted) ----
if [[ "$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)" == "None" ]]; then
  aws ec2 create-default-vpc --region "$REGION" >/dev/null && echo "created the default VPC"
fi

# ---- environment for the container ----
container=$(python3 - "$IMAGE" <<'PY'
import json, os, sys
e = {"HOST": "0.0.0.0", "NODE_ENV": "production", "DATA_DIR": "/tmp/powerline-data",
     "SIM_START_SOC": "55", "SIM_CLOCK_START": "2026-10-01T20:00:00Z", "TZ_OFFSET": "1"}
if os.environ.get("API_TOKEN_SECRET"): e["API_TOKENS"] = "judge:" + os.environ["API_TOKEN_SECRET"]
if os.environ.get("REGION"): e["AWS_REGION"] = os.environ["REGION"]
for k in ["STORE", "DYNAMO_TABLE", "BEDROCK_MODEL_ID", "ALLOWED_ORIGINS", "POWER_SOURCE", "VRM_DEMO", "VRM_SITE_ID", "WEATHER_LAT", "WEATHER_LON", "PUBLIC_URL"]:
    if os.environ.get(k): e[k] = os.environ[k]
print(json.dumps({"image": sys.argv[1], "containerPort": 3000, "environment": [{"name": k, "value": v} for k, v in e.items()]}))
PY
)

existing=$(find_service)
if [[ -n "$existing" ]]; then
  echo "Updating $SERVICE in $REGION to $IMAGE…"
  aws ecs update-express-gateway-service --region "$REGION" --service-arn "$existing" --primary-container "$container" \
    $( [[ -n "$TASK_ROLE_ARN" ]] && printf -- '--task-role-arn %s' "$TASK_ROLE_ARN" ) --monitor-resources --monitor-mode TEXT-ONLY >/dev/null
  arn=$existing
else
  echo "Creating ECS Express service '$SERVICE' in $REGION from $IMAGE…"
  arn=$(aws ecs create-express-gateway-service --region "$REGION" \
    --service-name "$SERVICE" \
    --primary-container "$container" \
    --execution-role-arn "$exec_role" \
    --infrastructure-role-arn "$infra_role" \
    $( [[ -n "$TASK_ROLE_ARN" ]] && printf -- '--task-role-arn %s' "$TASK_ROLE_ARN" ) \
    --cpu 1024 --memory 2048 --cpu-architecture X86_64 \
    --health-check-path /healthz \
    --scaling-target '{"minTaskCount":1,"maxTaskCount":1}' \
    --monitor-resources --monitor-mode TEXT-ONLY \
    --query 'service.serviceArn' --output text)
fi
echo "Service: $arn — waiting for the deployment to finish (≈3–6 min)…"
sleep 20
# A rolling deployment keeps the old task serving until the new one is healthy; wait for the swap so the probe below sees the new settings.
dep=$(aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$arn" --query 'service.currentDeployment' --output text 2>/dev/null || true)
if [[ -n "$dep" && "$dep" != "None" ]]; then
  for i in $(seq 1 60); do
    ds=$(aws ecs describe-service-deployments --region "$REGION" --service-deployment-arns "$dep" --query 'serviceDeployments[0].status' --output text 2>/dev/null || echo UNKNOWN)
    [[ "$ds" == "SUCCESSFUL" || "$ds" == "UNKNOWN" ]] && break
    [[ "$ds" == *FAILED* || "$ds" == *ROLLED_BACK* ]] && { echo "deployment $ds — most common cause: the image is private on GitHub, or the task crashed; see the ECS console → powerline → Deployments"; exit 1; }
    sleep 10
  done
fi
for i in $(seq 1 90); do
  status=$(aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$arn" --query 'service.status.statusCode' --output text 2>/dev/null || echo PENDING)
  [[ "$status" == "ACTIVE" ]] && break
  [[ "$status" == *FAILED* ]] && { echo "deployment failed ($status). Most common cause: the image is private — make the GitHub package public and rerun."; aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$arn" --query 'service.status' ; exit 1; }
  sleep 10
done
url=$(aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$arn" --query 'service.activeConfigurations[0].ingressPaths[0].endpoint' --output text 2>/dev/null || true)
[[ -z "$url" || "$url" == "None" ]] && url=$(aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$arn" --output json | python3 -c 'import json,sys,re; print((re.findall(r"https?://[\w.\-]+\.on\.aws", sys.stdin.read()) or [""])[0])')
url=${url#https://}; url=${url%/}
echo
echo "Powerline is live:  https://$url/          (status page)"
echo "Simulated host:     https://$url/demo      (judges open this)"
echo "MCP endpoint:       https://$url/mcp       (OAuth-capable hosts link here with no token)"
[[ -n "$API_TOKEN_SECRET" ]] && echo "Bearer token:       $API_TOKEN_SECRET   ← Devpost testing instructions (household 'judge' on the consent page)"
# The service reports ACTIVE before its load balancer and DNS record exist; the name resolves a few minutes later.
echo "Waiting for the URL to come up (DNS + first task, usually 3–8 minutes)…"
for i in $(seq 1 90); do curl -fsS "https://$url/healthz" 2>/dev/null && { echo; echo "Live. Open https://$url/demo"; exit 0; }; sleep 10; done
echo "Still not answering after 15 minutes. Check: aws ecs describe-express-gateway-service --region $REGION --service-arn $arn --query service.status"
echo "and the service's Deployments tab in the ECS console (a private image shows there as CannotPullContainerError)."
