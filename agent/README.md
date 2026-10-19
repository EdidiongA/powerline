# Powerline evening agent (Strands Agents + Amazon Bedrock)

An autonomous agent that plans the household's day **before anyone asks**. Each run it connects to
Powerline over MCP (Streamable HTTP, bearer token), checks the battery and the outage outlook, plans
tomorrow around the sun and the reserve, **arms the plan** so Powerline itself reminds the household at
each start time, and returns one short paragraph. Run it every evening (cron, EventBridge Scheduler)
and the morning reminders are already set.

- `powerline_agent.py` — the agent: [Strands Agents](https://strandsagents.com) `Agent` + `BedrockModel`
  (Claude Haiku 4.5 by default) + `MCPClient` over Streamable HTTP. Powerline's tools become the agent's tools — all but `buy_units`, which an unattended agent is never given.
- `agentcore_app.py` — the same agent as an **Amazon Bedrock AgentCore Runtime** app (`BedrockAgentCoreApp`,
  `/ping` + `/invocations`). **Deployed to AgentCore Runtime** (us-east-1, direct code deploy, 19 Oct 2026) and invoked there against the live Powerline: it planned and armed the household's day. Also tested locally against the same HTTP contract in CI.
- `test_agent.py` — starts a real Powerline process and runs the agent with a scripted stand-in model
  (no AWS needed): the agent's tool calls go over MCP and the plan ends up armed on the server. Runs in CI.

## Run it against Bedrock — easiest from AWS CloudShell (credentials already there)

CloudShell's `python3` is 3.9 and Strands needs 3.10+, so the first two lines install Python 3.11 and make a
virtual environment with it (about 250 MB in your CloudShell home; a new CloudShell tab only needs the `source` line again).

```bash
sudo dnf install -y python3.11 python3.11-pip
python3.11 -m venv ~/acv && source ~/acv/bin/activate
git clone https://github.com/EdidiongA/powerline && cd powerline
pip install -r agent/requirements.txt
python agent/powerline_agent.py \
  --url https://po-39e714efffb84f8b9a5548f7fa1ca5cf.ecs.us-east-1.on.aws/mcp \
  --token <the household's token>
```

It prints a paragraph like *"Your battery holds through tonight… I've armed reminders for the pump at
08:00 and the iron at 09:00…"*. Open the live `/demo` afterwards and ask "Plan my power for today": the
card shows the plan as armed.

Locally (any machine with Python 3.10+ and AWS credentials): `npm run build && npm start` in one terminal,
then `python agent/powerline_agent.py` (defaults to `http://127.0.0.1:3000/mcp`).

## Deploy it to Amazon Bedrock AgentCore Runtime (from AWS CloudShell)

Run these **from inside the `agent/` folder**: the toolkit packages the folder it runs in and looks for
`requirements.txt` there. Run from the repo root, it would ship the agent without its packages.
Uses the same Python 3.11 environment as above (create it first if you skipped that section).

```bash
source ~/acv/bin/activate
cd ~/powerline/agent
pip install -r requirements.txt bedrock-agentcore-starter-toolkit uv
export AGENTCORE_SUPPRESS_RECOMMENDATION=1
agentcore configure -e agentcore_app.py -n powerline_evening_agent -dt direct_code_deploy -rt PYTHON_3_11 -r us-east-1 -dm -ni
agentcore deploy --env POWERLINE_URL=https://<your-powerline>/mcp --env POWERLINE_TOKEN=<household token>
agentcore invoke '{"prompt": "Plan tomorrow for this household."}'
```

`uv` is required by the toolkit to build the ARM64 dependency bundle; the toolkit creates the execution
role (Bedrock invoke on foundation models and this account's inference profiles) and an S3 bucket for the
code. Remove everything afterwards with `agentcore destroy`.

## Test it without AWS

```bash
npm run build
pip install -r agent/requirements.txt
python -m unittest agent/test_agent.py
```
