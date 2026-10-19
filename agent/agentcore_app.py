"""
The Powerline evening agent as an Amazon Bedrock AgentCore Runtime app.

AgentCore Runtime hosts the agent (session isolation, scaling, IAM identity, logs); this file is
its entrypoint. Each invocation runs the same Strands agent as powerline_agent.py against the
household's Powerline MCP server. Configure the target with environment variables:

    POWERLINE_URL    e.g. https://<your-powerline>/mcp
    POWERLINE_TOKEN  the household's bearer token
    BEDROCK_MODEL_ID optional; defaults to Claude Haiku 4.5 (us inference profile)

Invoke with a JSON payload: {"prompt": "Plan tomorrow for this household."}  (prompt is optional)
Local run:  python agent/agentcore_app.py   → POST http://localhost:8080/invocations
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bedrock_agentcore.runtime import BedrockAgentCoreApp  # noqa: E402

import powerline_agent  # noqa: E402

app = BedrockAgentCoreApp()

# Replaced in tests with a scripted stand-in; None means Claude on Amazon Bedrock.
model_factory = lambda: None  # noqa: E731


@app.entrypoint
def invoke(payload) -> dict:
    # Accept {"prompt": "..."}, a bare string, or nothing at all.
    prompt = payload.get("prompt") if isinstance(payload, dict) else payload if isinstance(payload, str) else None
    prompt = str(prompt or "Plan tomorrow for this household.")[:2000]
    url = os.environ.get("POWERLINE_URL")
    if not url:
        # An error status, so a misconfigured runtime never looks healthy.
        raise RuntimeError("POWERLINE_URL is not set on this runtime (agentcore deploy --env POWERLINE_URL=https://<powerline>/mcp)")
    text = powerline_agent.run(url, os.environ.get("POWERLINE_TOKEN"), prompt, model=model_factory())
    return {"result": text}


if __name__ == "__main__":
    app.run()
