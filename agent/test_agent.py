"""
End-to-end test of the Strands agent against a real Powerline process, without AWS:
a scripted stand-in replaces the Bedrock model and drives the same tool calls Claude makes.
It proves the wiring — Strands' MCP client, Streamable HTTP, bearer auth, Powerline's tools —
and that the run leaves the household's plan armed on the server.

    npm run build && python -m unittest agent/test_agent.py
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import powerline_agent  # noqa: E402
from strands.models import Model  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = "agent-test-secret-123"


class ScriptedModel(Model):
    """Plays one tool call per turn, then a closing paragraph; records every tool result it is shown."""

    def __init__(self, calls):
        self.calls = list(calls)
        self.seen_results = []

    def update_config(self, **_):
        pass

    def get_config(self):
        return {}

    async def structured_output(self, *a, **k):  # pragma: no cover
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **_):
        for block in (messages[-1].get("content") or []) if messages else []:
            if "toolResult" in block:
                self.seen_results.append(block["toolResult"])
        names = {s["name"] for s in (tool_specs or [])}
        self.offered = names
        yield {"messageStart": {"role": "assistant"}}
        if self.calls:
            name, args = self.calls.pop(0)
            assert name in names, f"{name} not offered to the model: {sorted(names)}"
            yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": f"t{len(self.seen_results)}", "name": name}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(args)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": "Battery holds tonight; reminders are armed for tomorrow morning."}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class AgentEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        env = {**os.environ, "PORT": str(cls.port), "DATA_DIR": tempfile.mkdtemp(prefix="pl-agent-"),
               "API_TOKENS": f"home:{TOKEN}", "SIM_STEADY": "1", "SIM_SPEED": "0.01", "SIM_START_SOC": "64",
               "SIM_CLOCK_START": "2026-10-01T20:00:00Z"}
        cls.proc = subprocess.Popen([os.environ.get("NODE", "node"), "dist/http.js"], cwd=ROOT, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(80):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/healthz", timeout=1)
                break
            except Exception:
                time.sleep(0.15)
        else:
            cls.proc.terminate()
            raise RuntimeError("Powerline did not start — run `npm run build` first")
        cls.url = f"http://127.0.0.1:{cls.port}/mcp"

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)

    def household(self) -> dict:
        with powerline_agent.mcp_client(self.url, TOKEN) as c:
            return json.loads(c.read_resource_sync("powerline://household").contents[0].text)

    def test_agent_plans_and_arms_through_mcp(self):
        # The household knows its system and two appliances (what a person would have said to Alexa+ earlier).
        with powerline_agent.mcp_client(self.url, TOKEN) as c:
            c.call_tool_sync("s1", "setup_system", {"arrayKw": 4.5, "batteryKwh": 10, "inverterKw": 5, "reserveSocPct": 20})
            c.call_tool_sync("s2", "add_appliance", {"name": "iron", "watts": 2000, "minutes": 30})
            c.call_tool_sync("s3", "add_appliance", {"name": "pump"})
        model = ScriptedModel([("power_status", {}), ("outage_outlook", {}), ("plan_day", {}), ("arm_plan", {}), ("prepaid_units", {})])
        text = powerline_agent.run(self.url, TOKEN, model=model)
        self.assertTrue(text, "the agent returns its closing paragraph")
        self.assertEqual(len(model.seen_results), 5, "every tool result came back to the model")
        self.assertTrue(all(r["status"] == "success" for r in model.seen_results), model.seen_results)
        joined = " ".join(c.get("text", "") for r in model.seen_results for c in r["content"])
        self.assertIn("reserve", joined)
        self.assertIn("pump", joined, "plan_day's real output reached the model")
        armed = (self.household().get("armedPlan") or {}).get("items", [])
        self.assertEqual(sorted(i["name"] for i in armed), ["iron", "pump"], "the plan is armed on the server")

    def test_agent_is_never_handed_the_purchase_tool(self):
        model = ScriptedModel([])
        powerline_agent.run(self.url, TOKEN, model=model)
        self.assertIn("prepaid_units", model.offered, "it can read the units outlook")
        self.assertNotIn("buy_units", model.offered, "an unattended agent must not be able to spend money")

    def test_wrong_token_is_refused(self):
        with self.assertRaises(powerline_agent.PowerlineUnreachable):
            powerline_agent.run(self.url, "not-the-token", model=ScriptedModel([]))

    def test_unreachable_server_is_a_clear_error(self):
        with self.assertRaises(powerline_agent.PowerlineUnreachable):
            powerline_agent.run(f"http://127.0.0.1:{free_port()}/mcp", TOKEN, model=ScriptedModel([]))

    def test_defaults_to_claude_on_bedrock(self):
        agent = powerline_agent.build_agent([])
        self.assertEqual(type(agent.model).__name__, "BedrockModel")
        self.assertEqual(agent.model.get_config()["model_id"], os.environ.get("BEDROCK_MODEL_ID", powerline_agent.DEFAULT_MODEL))


class AgentCoreRuntimeContract(AgentEndToEnd):
    """The AgentCore entrypoint over its real HTTP contract (/ping, /invocations), same live Powerline."""

    def test_invocations_endpoint_runs_the_agent(self):
        try:
            import agentcore_app
        except ImportError:
            self.skipTest("bedrock-agentcore not installed")
        from starlette.testclient import TestClient
        with powerline_agent.mcp_client(self.url, TOKEN) as c:
            c.call_tool_sync("s1", "add_appliance", {"name": "kettle"})
        saved = {k: os.environ.get(k) for k in ("POWERLINE_URL", "POWERLINE_TOKEN")}
        try:
            os.environ["POWERLINE_URL"], os.environ["POWERLINE_TOKEN"] = self.url, TOKEN
            agentcore_app.model_factory = lambda: ScriptedModel([("power_status", {})])
            client = TestClient(agentcore_app.app, raise_server_exceptions=False)
            self.assertEqual(client.get("/ping").status_code, 200)
            r = client.post("/invocations", json={"prompt": "How are we tonight?"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["result"])
            self.assertEqual(client.post("/invocations", json="Plan tomorrow").status_code, 200, "a bare string payload is a prompt")
            del os.environ["POWERLINE_URL"]
            self.assertGreaterEqual(client.post("/invocations", json={}).status_code, 400, "a misconfigured runtime is an error, not a 200")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    # The inherited tests already ran once in the parent class.
    test_agent_plans_and_arms_through_mcp = None
    test_wrong_token_is_refused = None
    test_unreachable_server_is_a_clear_error = None
    test_defaults_to_claude_on_bedrock = None


if __name__ == "__main__":
    unittest.main()
