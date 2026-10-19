"""
Powerline evening agent — an autonomous planner built with the Strands Agents SDK on Amazon Bedrock.

It connects to a Powerline MCP server over Streamable HTTP (the same endpoint Alexa+ hosts use),
checks the battery and the outage outlook, plans tomorrow around the sun, arms the plan when it is
safe so Powerline itself reminds the household at each start time, and returns a short summary.
Run it on a schedule (cron, EventBridge) and the household's day is planned before anyone asks.

    pip install -r agent/requirements.txt
    python agent/powerline_agent.py --url https://<your-powerline>/mcp --token <household secret>

AWS credentials and region come from the usual places (environment, ~/.aws, or an IAM role).
"""
from __future__ import annotations

import argparse
import contextlib
import os
import sys

from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client
from strands import Agent
from strands.tools.mcp import MCPClient
from strands.types.exceptions import MCPClientInitializationError

DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

SYSTEM_PROMPT = """You are Powerline's evening planning agent for one household in a place where grid power is unreliable.
You act on the household's behalf, using only Powerline's tools; never invent numbers.
Every run:
1. Call power_status to see the battery, solar, load and grid now.
2. Call outage_outlook to see how long the battery would last if the grid went off.
3. Call plan_day to schedule the household's known appliances around tomorrow's sun and the battery reserve.
4. If the plan schedules at least one appliance, call arm_plan so Powerline reminds the household at each start time.
   Do not arm if nothing could be scheduled.
5. Call prepaid_units. If it says the units will run out or suggests a top-up, say so and give the amount;
   you cannot buy units yourself — the household decides that.
6. Finish with one short paragraph for the household: the battery outlook for tonight, what you armed and when,
   and anything to avoid. Plain words, no lists, no markdown."""


@contextlib.asynccontextmanager
async def _streamable_http(url: str, headers: dict[str, str] | None):
    # The HTTP client carries the bearer header and MCP's recommended timeouts; it is closed with the session.
    async with create_mcp_http_client(headers=headers) as http:
        async with streamable_http_client(url, http_client=http) as streams:
            yield streams


def mcp_client(url: str, token: str | None) -> MCPClient:
    headers = {"Authorization": f"Bearer {token}"} if token else None
    return MCPClient(lambda: _streamable_http(url, headers))


# Tools this unattended agent must never hold. buy_units spends money; only a person asks for that.
WITHHELD_TOOLS = frozenset({"buy_units"})


def allowed_tools(tools: list) -> list:
    return [t for t in tools if getattr(t, "tool_name", None) not in WITHHELD_TOOLS]


def build_agent(tools: list, model=None) -> Agent:
    """The model defaults to Claude on Amazon Bedrock; tests pass a scripted stand-in."""
    if model is None:
        from strands.models import BedrockModel
        model = BedrockModel(
            model_id=os.environ.get("BEDROCK_MODEL_ID", DEFAULT_MODEL),
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
    return Agent(model=model, tools=tools, system_prompt=SYSTEM_PROMPT, callback_handler=None)


class PowerlineUnreachable(RuntimeError):
    """Powerline could not be reached or refused the token."""


def run(url: str, token: str | None, prompt: str = "Plan tomorrow for this household.", model=None) -> str:
    try:
        with mcp_client(url, token) as client:
            agent = build_agent(allowed_tools(client.list_tools_sync()), model=model)
            result = agent(prompt)
            return str(result).strip()
    except MCPClientInitializationError as e:
        raise PowerlineUnreachable(
            f"Could not open an MCP session with Powerline at {url}. "
            "Check that the URL ends in /mcp and the server is up, and that the token is the household's secret."
        ) from e


def main() -> int:
    p = argparse.ArgumentParser(description="Powerline evening agent (Strands + Amazon Bedrock)")
    p.add_argument("--url", default=os.environ.get("POWERLINE_URL", "http://127.0.0.1:3000/mcp"), help="Powerline MCP endpoint")
    p.add_argument("--token", default=os.environ.get("POWERLINE_TOKEN"), help="household bearer token (if the server requires one)")
    p.add_argument("--prompt", default="Plan tomorrow for this household.", help="what to ask the agent")
    a = p.parse_args()
    try:
        print(run(a.url, a.token, a.prompt))
    except PowerlineUnreachable as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
