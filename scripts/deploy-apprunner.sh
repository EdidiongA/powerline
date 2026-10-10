#!/usr/bin/env bash
# One-shot deploy of this repo to AWS App Runner from GitHub, using the AWS CLI.
# Prereqs: aws CLI logged in (aws sts get-caller-identity works), and a GitHub connection in App Runner
# (console → App Runner → GitHub connections → Add new → authorise → copy its ARN).
#
#   CONNECTION_ARN=arn:aws:apprunner:...:connection/... \
#   API_TOKEN_SECRET=$(openssl rand -hex 24) \
#   bash scripts/deploy-apprunner.sh
#
# Prints the service URL. Add the token to Devpost's testing instructions as "Authorization: Bearer <secret>".
set -euo pipefail
: "${CONNECTION_ARN:?set CONNECTION_ARN to your App Runner GitHub connection ARN}"
REPO_URL=${REPO_URL:-https://github.com/EdidiongA/powerline}
BRANCH=${BRANCH:-main}
SERVICE=${SERVICE:-powerline}
REGION=${AWS_REGION:-us-east-1}
API_TOKEN_SECRET=${API_TOKEN_SECRET:-}
ROLE_ARN=${INSTANCE_ROLE_ARN:-}   # optional: role with DynamoDB + Bedrock access

env_json=$(python3 - <<PY
import json, os
e = {"HOST": "0.0.0.0", "NODE_ENV": "production", "DATA_DIR": "/tmp/powerline-data",
     "SIM_START_SOC": "55", "SIM_CLOCK_START": "2026-10-01T20:00:00Z", "TZ_OFFSET": "1"}
if os.environ.get("API_TOKEN_SECRET"): e["API_TOKENS"] = "judge:" + os.environ["API_TOKEN_SECRET"]
for k in ["STORE", "DYNAMO_TABLE", "BEDROCK_MODEL_ID", "AWS_REGION", "ALLOWED_ORIGINS", "POWER_SOURCE", "VRM_DEMO", "VRM_SITE_ID"]:
    if os.environ.get(k): e[k] = os.environ[k]
print(json.dumps(e))
PY
)

cat > /tmp/powerline-apprunner.json <<JSON
{
  "ServiceName": "$SERVICE",
  "SourceConfiguration": {
    "AuthenticationConfiguration": { "ConnectionArn": "$CONNECTION_ARN" },
    "AutoDeploymentsEnabled": false,
    "CodeRepository": {
      "RepositoryUrl": "$REPO_URL",
      "SourceCodeVersion": { "Type": "BRANCH", "Value": "$BRANCH" },
      "CodeConfiguration": {
        "ConfigurationSource": "API",
        "CodeConfigurationValues": {
          "Runtime": "NODEJS_22",
          "BuildCommand": "npm ci && npm run build",
          "StartCommand": "node dist/http.js",
          "Port": "3000",
          "RuntimeEnvironmentVariables": $env_json
        }
      }
    }
  },
  "InstanceConfiguration": { "Cpu": "1 vCPU", "Memory": "2 GB"$( [[ -n "$ROLE_ARN" ]] && printf ', "InstanceRoleArn": "%s"' "$ROLE_ARN" ) },
  "HealthCheckConfiguration": { "Protocol": "HTTP", "Path": "/healthz", "Interval": 10, "Timeout": 5, "HealthyThreshold": 1, "UnhealthyThreshold": 5 }
}
JSON

echo "Creating App Runner service '$SERVICE' in $REGION from $REPO_URL ($BRANCH)…"
arn=$(aws apprunner create-service --region "$REGION" --cli-input-json file:///tmp/powerline-apprunner.json --query 'Service.ServiceArn' --output text)
echo "Service ARN: $arn — waiting for the first deployment (≈5 min)…"
for i in $(seq 1 60); do
  status=$(aws apprunner describe-service --region "$REGION" --service-arn "$arn" --query 'Service.Status' --output text)
  [[ "$status" == "RUNNING" ]] && break
  [[ "$status" == "CREATE_FAILED" ]] && { echo "deployment failed — open the service's logs in the console"; exit 1; }
  sleep 10
done
url=$(aws apprunner describe-service --region "$REGION" --service-arn "$arn" --query 'Service.ServiceUrl' --output text)
echo
echo "Powerline is live:  https://$url/          (status page)"
echo "Simulated host:     https://$url/demo      (judges open this)"
echo "MCP endpoint:       https://$url/mcp"
[[ -n "$API_TOKEN_SECRET" ]] && echo "Bearer token:       $API_TOKEN_SECRET   ← put this in Devpost's testing instructions"
curl -fsS "https://$url/healthz" && echo
