# Deploying Powerline where Alexa+ can reach it

Alexa+ connects to MCP servers over the public internet. Locally, MCPJam talks to
`http://127.0.0.1:3000/mcp`; for a real device the same server needs a public HTTPS URL,
a bearer token, and the host's origin in `ALLOWED_ORIGINS`. Three ways, cheapest first.

## 1. Tunnel from your laptop (demo, minutes)

```bash
API_TOKENS=home:$(openssl rand -hex 24) HOST=0.0.0.0 npm start
ngrok http 3000            # gives https://<id>.ngrok.app
```

Register `https://<id>.ngrok.app/mcp` with the host and send `Authorization: Bearer <token>`.
Everything else is unchanged. The tunnel dies with your laptop; fine for a demo, not for a household.

## 2. AWS App Runner from the GitHub repo (always on, no Docker needed, ~$5/month idle)

**Fastest:** one GitHub connection in the App Runner console, then one command —

```bash
CONNECTION_ARN=arn:aws:apprunner:us-east-1:<acct>:connection/<name>/<id> \
API_TOKEN_SECRET=$(openssl rand -hex 24) \
bash scripts/deploy-apprunner.sh          # prints the live /demo URL and the token for judges
```

Add `STORE=dynamodb DYNAMO_TABLE=powerline BEDROCK_MODEL_ID=… INSTANCE_ROLE_ARN=…` to the same command for
the full AWS path. The manual route, if you prefer the console:

The repo carries an `apprunner.yaml`, so App Runner can build and run it straight from GitHub:

1. Console → **App Runner → Create service** → Source: **Source code repository** → connect GitHub → pick `EdidiongA/powerline`, branch `main` → Deployment trigger *Manual* (or *Automatic*).
2. Configure build: **Use a configuration file** (it reads `apprunner.yaml`).
3. Configure service: name `powerline`, 1 vCPU / 2 GB is plenty, **port 3000**, health check path **`/healthz`**.
4. Environment variables (Service settings → Environment variables), at minimum:

| Variable | Value |
| --- | --- |
| `API_TOKENS` | `judge:<long random secret>` — the secret goes into the Devpost testing instructions |
| `ALLOWED_ORIGINS` | the host's origin, if a browser host will connect (e.g. `https://inspector.mcpjam.com`) |
| `STORE` / `DYNAMO_TABLE` / `AWS_REGION` | `dynamodb` / `powerline` / `us-east-1` |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `SIM_START_SOC` / `SIM_CLOCK_START` | leave unset for a live clock, or set for a scripted demo state |

5. Security → **Instance role**: a role with `AmazonDynamoDBFullAccess` (or a policy scoped to the table) and `AmazonBedrockFullAccess` (or `bedrock:InvokeModel` on the model). App Runner → the role's trust policy must allow `tasks.apprunner.amazonaws.com`.
6. Create. First build takes ~5 minutes; the service URL is `https://<id>.<region>.awsapprunner.com`. Check `https://<url>/healthz` and open `https://<url>/` for the status page.

Cost with the hackathon credits: effectively zero. Pause the service from the console when not demoing.

### 2b. The same thing as a container

```bash
aws ecr create-repository --repository-name powerline
docker build -t powerline . && docker tag powerline:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/powerline:latest
aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/powerline:latest
```

Create an App Runner service from that image with port `3000`, health check path `/healthz`, and environment:

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `API_TOKENS` | `home:<long random secret>` (one entry per household) |
| `STORE` | `dynamodb` — App Runner instances are replaced; disk is not durable there |
| `DYNAMO_TABLE` / `AWS_REGION` | `powerline` / `us-east-1` (run `npm run dynamo:init` once) |
| `POWER_SOURCE` + credentials | `victron` + `VRM_TOKEN` + `VRM_SITE_ID`, or `growatt` + `GROWATT_TOKEN` |
| `BEDROCK_MODEL_ID` | e.g. `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `TZ_OFFSET` | the household's UTC offset |

Give the service's instance role `dynamodb:GetItem/PutItem/UpdateItem` on the table and
`bedrock:InvokeModel` on the model. App Runner terminates TLS and provides the HTTPS URL.

**Streamable HTTP needs sticky sessions or a single instance.** Sessions live in the process
that opened them (`MCP-Session-Id` → transport). Run one instance, or put a session-affinity
load balancer in front. A client whose session lands on another instance gets `404` and
re-initialises — correct per spec, but it loses the open SSE stream until it reconnects.

## 3. Your own box (Raspberry Pi next to the inverter)

```bash
docker compose up -d           # or: npm run build && npm start under systemd
```

Then expose it with Cloudflare Tunnel or Tailscale Funnel for HTTPS without opening a port.
This is the deployment that makes sense for a household: the data never leaves the house
except to the assistant, and a local Victron/Growatt connection is a one-line adapter change.

## Linking from a host (OAuth)

Once the server is public with `API_TOKENS` set, a host that follows the MCP authorization spec needs only the
endpoint URL: it will hit `401`, read `resource_metadata`, register itself, send the person to
`https://<url>/oauth/authorize`, and exchange the code. The person types the household name and its
secret once on Powerline's consent page; the host keeps an expiring token and refreshes it. No token is
ever pasted into the host by hand.

## Checklist before registering with a host

- `curl https://<url>/healthz` → `{"ok":true,…}`
- `curl -X OPTIONS https://<url>/mcp -H 'Origin: https://<host origin>' -i` → `204` with `Access-Control-Allow-Origin`
- `curl -X POST https://<url>/mcp …` without a token → `401` (never `200`)
- `SESSION_TTL_MS` long enough for the household's quietest stretch (default 6 h)
