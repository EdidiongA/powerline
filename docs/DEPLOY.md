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

## 2. Amazon ECS Express Mode (always on, public HTTPS, no Docker on your machine)

> AWS App Runner stopped accepting new customers on 30 April 2026; ECS Express Mode is what AWS points
> to instead. It gives a Fargate task behind a load balancer with a `https://<name>.ecs.<region>.on.aws`
> URL from one CLI call.

The image is built by GitHub Actions (`.github/workflows/image.yml`) on every push to `main` and
published to `ghcr.io/<you>/powerline:latest`. Make that package **public** once (GitHub → your
profile → *Packages* → *powerline* → *Package settings* → *Change visibility*), then from
**AWS CloudShell** (the `>_` icon in the console footer; nothing to install, no keys):

```bash
curl -fsSL https://raw.githubusercontent.com/EdidiongA/powerline/main/scripts/deploy-ecs-express.sh -o deploy.sh
API_TOKEN_SECRET=$(openssl rand -hex 24) bash deploy.sh     # prints the live /demo URL and the judge token
```

The script creates the two IAM roles Express Mode needs (idempotent), restores the default VPC if it
is missing, creates the service with port `3000`, health check `/healthz`, one task, and prints the URL
when `/healthz` answers. Run it again to roll a new image; `bash deploy.sh delete` tears it down.

For the full AWS path add `STORE=dynamodb DYNAMO_TABLE=powerline BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0 TASK_ROLE_ARN=<role>`
to the same command, where the role trusts `ecs-tasks.amazonaws.com` and allows `dynamodb:GetItem/PutItem/UpdateItem`
on the table and `bedrock:InvokeModel` on the model. Without it the service runs the simulator on
ephemeral disk — a complete demo, reset on each deploy.

Environment the container understands (all optional beyond `API_TOKENS`):

| Variable | Value |
| --- | --- |
| `API_TOKENS` | `judge:<long random secret>` — the secret goes into the Devpost testing instructions; the same pair works on the OAuth consent page |
| `ALLOWED_ORIGINS` | a browser host's origin, if one will connect (e.g. `https://inspector.mcpjam.com`) |
| `STORE` / `DYNAMO_TABLE` / `AWS_REGION` | `dynamodb` / `powerline` / `us-east-1` |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `SIM_START_SOC` / `SIM_CLOCK_START` | leave unset for a live clock, or set for a scripted demo state |
| `WEATHER_LAT` / `WEATHER_LON` | coordinates for the weather-aware solar curve (live clock only) |
| `PUBLIC_URL` | not needed here — the load balancer sends `x-forwarded-proto` and the public `Host` |

Cost with the hackathon credits: effectively zero (one 1 vCPU / 2 GB task plus the load balancer).
Delete the service when the judging period ends.

### 2b. The same image from Amazon ECR instead of GitHub

```bash
aws ecr create-repository --repository-name powerline
docker build -t powerline . && docker tag powerline:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/powerline:latest
aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/powerline:latest
IMAGE=<acct>.dkr.ecr.us-east-1.amazonaws.com/powerline:latest API_TOKEN_SECRET=… bash scripts/deploy-ecs-express.sh
```

**Streamable HTTP needs sticky sessions or a single instance.** Sessions live in the process
that opened them (`MCP-Session-Id` → transport). The deploy script pins one task for that reason; scale out only behind a session-affinity
load balancer. A client whose session lands on another instance gets `404` and
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
