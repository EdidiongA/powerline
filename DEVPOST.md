# Powerline — Devpost submission draft

> Working draft. Sections marked **[verify]** or **[fill]** need Edidiong's own words or a final number.
> Keep this file in the repo; paste into Devpost in mid-October after the final build.

---

## Project name (≤60)

Powerline — Home Power Copilot for Alexa+

## Elevator pitch (≤200)

An Alexa+ MCP add-on that knows your solar, battery and grid, forecasts your battery, and answers "can I run the iron now?" with live cards and proactive low-battery alerts.

---

## Project story

### Inspiration

In Lagos, where I live, the grid is a rumour. Most households I know run a hybrid inverter — a solar array, a battery, and a grid connection that comes and goes in "bands" — and make a dozen small power decisions a day by guesswork: *Can I iron now or will that kill the battery before morning? Should the freezer stay on tonight? When is grid likely to come back?* The data to answer those questions already exists — every modern inverter streams solar, load and state-of-charge to a cloud portal — but it is buried in a monitoring app nobody opens at 9 pm with an iron in their hand.

Alexa+ made the missing piece obvious. If the assistant in the living room could *ask the inverter*, hold the household's context across sessions, and push a warning before the battery hits its floor, the guesswork disappears. The same problem exists far beyond West Africa: time-of-use tariffs in Europe and the US, grid instability in South Asia and Latin America, and the roughly **[verify: cite a figure — e.g. IEA estimate of households on unreliable grids]** households worldwide living with intermittent supply.

### What it does

Powerline is a self-hosted **MCP server over Streamable HTTP (spec 2025-11-25)** that turns a home inverter into something you can talk to:

- **"How's the power?"** — live solar, load, battery and grid state, plus a 24-hour battery forecast, rendered as an interactive **MCP App dashboard card** inline in the conversation.
- **"Can I run the iron for 30 minutes?"** — a real answer from a physics-based forecast: yes, or *not now — best time 10:00*, with the projected battery low point.
- **"Plan my power for today"** — a greedy scheduler places every known appliance into the earliest slot that keeps the battery above its reserve, preferring solar-surplus hours. The **planner card** lets you tick appliances on and off and re-plans live through the host.
- **Proactive alerts** — a per-session monitor pushes MCP notifications over the Streamable HTTP GET stream when the battery gets within ten points of the reserve, reaches it, or the grid flips. No request needed; the assistant simply tells you.
- **Household memory that outlives the session** — system profile, appliances and a rolling log of grid on/off events persist across MCP sessions. From the event log Powerline learns the household's typical grid-availability pattern per weekday-hour and feeds it into every forecast.
- **Evening briefing** — one spoken paragraph, generated with **Amazon Bedrock**, summarising overnight risk, expected grid windows and what to avoid. **[verify after Bedrock is enabled]**
- **Multi-vendor telemetry** — one adapter interface, three implementations: **Victron VRM** (tested live against a real installation via the VRM API), **Growatt OpenAPI** (ShinePhone token), and a deterministic simulator for demos and tests.

### How I built it

- **Transport:** `@modelcontextprotocol/server` v2, `WebStandardStreamableHTTPServerTransport`, one `McpServer` per session keyed by `MCP-Session-Id`, Origin validation, 404 on dead sessions, DELETE for termination — the sessionful profile of the 2025-11-25 spec, served through Hono on Node 22.
- **MCP Apps:** `@modelcontextprotocol/ext-apps` v2. Two `ui://` resources (dashboard, planner) built with Vite into single-file HTML; the planner calls back into the server with `callServerTool` when the user toggles an appliance.
- **Forecast engine:** pure TypeScript, no I/O. `net = pv + grid − load`, SOC integrated at 15-minute steps and clamped; the grid covers deficits only when the learned pattern says it is available. `can_i_run` and `plan_day` re-run the forecast with the appliance added and search for harmless slots. **11 tests**, including property-style tests for SOC bounds and monotonicity.
- **Alerts:** background monitor per session using `sendLoggingMessage`, with hysteresis and a repeat cadence (because the transport silently drops notifications when no GET stream is open).
- **State:** one store interface, two backends — disk for zero-setup, **Amazon DynamoDB** for the
  real thing, with optimistic concurrency so the alert monitor and tool calls cannot lose each
  other's writes.
- **AWS:** **Bedrock** (Converse API, Claude Haiku) generates the spoken evening briefing;
  **DynamoDB** stores household state with conditional writes on a `version` attribute. Two
  services in one pipeline rather than a single model call.
- **Tooling:** Claude Code + the Amazon Devices Builder Tools MCP server for scaffolding and docs search; MCPJam Inspector as the MCP Apps host for development.

### Challenges I ran into

- **Two writers, one record.** Powerline writes household state from tool calls *and* from a
  background monitor that logs grid flips on a timer. The obvious DynamoDB implementation —
  read, modify, write — silently drops one of them. The fix is a `version` attribute with a
  conditional write, and on conflict re-applying the mutation to freshly read data. I proved it
  with a fake DynamoDB that actually enforces the condition, because a concurrency test against
  a fake that ignores conditions proves nothing.
- **Failure modes that only appear after an hour.** A client that closes its tab never sends
  DELETE, so its alert monitor polls forever; several of those exhaust the Victron API's rolling
  request limit mid-demo. Idle sessions are now reaped, and telemetry is shared and cached so
  upstream load is independent of session count.

- **SDK generation gap.** The TypeScript SDK split into v2 packages (`@modelcontextprotocol/server`, `core`, `client`) and MCP Apps 2.0 targets them, but most tutorials and the hackathon resources still reference `@modelcontextprotocol/sdk` v1. The two don't interoperate; I lost half a day before switching.
- **Silent failure modes in the transport.** `sendLoggingMessage()` resolves successfully and sends nothing unless the server declares the `logging` capability; notifications sent before the client opens its GET stream are dropped without error. Both are now documented in my friction log with suggested fixes.
- **Forecasting when the battery is already doomed.** My first `can_i_run` compared minimum SOC with and without the appliance — which goes blind once the baseline already hits 0%. The tests caught it; the rule is now "keep the reserve, or run entirely on solar surplus."
- **Vendor APIs.** Victron's VRM API is exemplary (self-serve tokens, a public demo user, a solar-forecast endpoint). Growatt's field names vary by model and the only reference is a Chinese-language showdoc; Deye/Solarman gates API keys behind a support-ticket approval, so I dropped it.
- **Windows tooling.** Old Node on the machine, a broken transitive dependency in the inspector's latest release, `cross-env` for per-page Vite builds — the ordinary friction of shipping on a laptop, all logged.

### Accomplishments I'm proud of

- A **real forecast**, not a wrapper: the answer to "can I run this?" comes from integrating the household's own numbers, and it changes when the sun, the grid pattern or the reserve change.
- **Bidirectional MCP Apps** — the planner card drives the server, not just displays it.
- **Server-initiated alerts** working end to end through a real host — the part of Streamable HTTP most submissions never touch.
- **Live data from a real Victron installation** flowing through the whole pipeline with zero hardware on my desk.
- **[fill: test count, lines, commits, friction-log entries at submission time]**

### What I learned

- The MCP spec's sessionful Streamable HTTP profile is small but has sharp edges; the transport, not the tools, is where the time goes.
- MCP Apps change what an assistant can be: a card that calls back into the server turns a chat into a control surface.
- Energy forecasting for a household is mostly bookkeeping — a clear-sky curve, a load profile and a learned grid pattern get you 80% of the value; the remaining 20% is honesty about uncertainty.
- **[fill: one personal line]**

### What's next

- Alexa account linking → per-household identity instead of `DEMO_USER_ID`; per-household timezone.
- Host the server on AgentCore; DynamoDB is already the store. **[verify]**
- Provider PV forecasts (VRM exposes one) blended with the clear-sky model; weather-aware cloud derating.
- More adapters via the one-file interface: Deye/Solarman, SolarEdge, Enphase.
- Appliance auto-discovery from smart plugs; "turn it off for me" via Alexa smart-home routines.
- Fire TV companion view of the same dashboard card.

---

## Built with (tags)

typescript, node.js, mcp, model-context-protocol, mcp-apps, streamable-http, hono, vite, zod, amazon-bedrock, aws, victron-vrm, growatt, alexa

## Links

- Repo: https://github.com/EdidiongA/powerline
- Video: **[fill]**
- Prior art acknowledged: https://github.com/gimi-q/victron-vrm-mcp (read-only API wrapper; Powerline differs in forecast, decision tools, memory, multi-vendor telemetry, cards)

---

## Additional Info (Step 4)

**Primary track:** Alexa+
**Mini-challenges:** AWS Builder; Open Source

### Open Source mini-challenge
- Contribution URL: https://github.com/EdidiongA/powerline
- Project repository URL: https://github.com/EdidiongA/powerline
- GitHub username: EdidiongA
- Description: New MIT-licensed open-source project created inside the hackathon window (first commit **[fill date]**). What it does: a stateful Streamable HTTP MCP server with MCP App cards, a tested battery-forecast engine, and a vendor-agnostic telemetry interface with Victron, Growatt and simulator adapters. How it works: see README architecture. Why it matters: it is a reusable reference for the sessionful Streamable HTTP + MCP Apps combination that the ecosystem currently lacks a combined example of, and the adapter interface lets other developers add inverter brands in one file. **[optional: add a PR to an upstream repo, e.g. a docs fix to ext-apps for the logging-capability trap]**

### Product feedback
See PRODUCT_FEEDBACK.md — must be written in first person from actual experience.

### Feature requests (optional)
1. **Streamable HTTP transport: warn or throw when a notification is dropped** (no GET stream / capability not declared). Why: cost me most of a day; silent drops are the worst class of bug. **Critical.**
2. **Hackathon resources: name the v2 SDK packages and link a combined Streamable HTTP + MCP Apps example.** Why: every entrant on this track hits the v1/v2 split. **Important.**
3. **ext-apps templates: multi-view build recipe** (one HTML per `ui://` resource). Why: real apps have more than one card. **Nice-to-have.**
4. **Alexa+ docs: state whether 2026-07-28 protocol servers are accepted** ("or a later version, once confirmed" is ambiguous). **Important.**

### Friction log
See FRICTION_LOG.md — **[fill: keep adding; target 10+ dated entries]**
