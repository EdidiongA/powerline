# Powerline — Alexa+ home power copilot

**Build, Ship, Shape: Amazon Developer Hackathon 2026 · Alexa+ track · AWS Builder + Open Source mini-challenges**

Millions of households on unreliable grids make power decisions by guesswork: *Can I run the iron? Will the
battery last the night? When is grid coming back?* Powerline makes the inverter conversational. It is a
stateful **Streamable HTTP MCP server (spec 2025-11-25)** that knows the household's solar array, battery,
inverter and learned grid pattern, answers "can I run X?" with a real forecast, and renders an interactive
**MCP App** dashboard card inline in the conversation.

Supported inverter platforms: **Growatt** (ShinePhone API token) and **Victron Energy** (VRM Portal access
token). A built-in simulator runs without any hardware.

## Quick start

```bash
npm install
npm run build          # bundles the MCP App card + compiles the server
npm start              # simulator; MCP endpoint at http://127.0.0.1:3000/mcp
npm run smoke          # (second terminal) full protocol round-trip through every tool
npm test               # forecast-engine tests
```

Live telemetry:

```bash
# Victron — your own site (VRM Portal → Preferences → Integrations → Access tokens)
POWER_SOURCE=victron VRM_TOKEN=... VRM_SITE_ID=123456 npm start
# Victron — public demo site, no account needed
POWER_SOURCE=victron VRM_DEMO=1 VRM_SITE_ID=219742 npm start
# Growatt (ShinePhone → Me → username → API Token; app-generated tokens are most reliable)
POWER_SOURCE=growatt GROWATT_TOKEN=... npm start
```

Connect any Streamable-HTTP + MCP-Apps client (Claude Desktop/claude.ai custom connector, VS Code, MCPJam,
Postman, Goose) to `/mcp`. For a public URL use `ngrok http 3000` and set `HOST=0.0.0.0`.

## Tools

| Tool | Say | Returns |
| --- | --- | --- |
| `power_status` | "How's the power?" | Solar / load / battery / grid + 24 h battery forecast. **Dashboard card.** |
| `can_i_run` | "Can I run the iron for 30 minutes?" | Yes / not now, projected SOC, best start time today. |
| `evening_briefing` | "Power briefing" | One spoken paragraph (Amazon Bedrock when configured). |
| `setup_system` | "Set up my solar" | Stores array kW, battery kWh, inverter kW, reserve %. Persists across sessions. |
| `add_appliance` / `list_appliances` | "Remember the washing machine is 500 watts" | Appliances by name for planning. |
| `log_grid_event` | "Grid just went off" | Feeds the learned per-weekday grid-availability pattern. |

## How it works

```
Alexa+ / MCP client ──Streamable HTTP (sessions, SSE)──▶ src/http.ts
                                                          └─ src/server.ts   tools + ui:// resource
                                                             ├─ src/forecast.ts   SOC integration, can_i_run, grid learning
                                                             ├─ src/store.ts      per-household state (survives sessions)
                                                             ├─ src/telemetry/    sim | victron (VRM v2) | growatt (OpenAPI v1)
                                                             ├─ src/bedrock.ts    Converse API briefing (AWS Builder)
                                                             └─ src/ui/card.*     MCP App dashboard (Vite → single HTML)
```

**Forecast engine** (`src/forecast.ts`, pure functions, tested): `net = pv + grid − load`, SOC integrated at
15-minute steps over the battery capacity and clamped; the grid covers deficits only when available.
`can_i_run` re-runs the forecast with the appliance added and, if the reserve would be breached, scans the
next 24 h for the earliest slot that either keeps SOC above the reserve or runs entirely on PV surplus.
Grid availability is learned from logged on/off events, binned per weekday-hour.

**Telemetry adapters** implement one interface (`src/telemetry/types.ts`) returning
`{pv_w, load_w, battery_w, soc_pct, grid_w, grid_available}`. Adding a brand is one file.

- **Victron VRM** — one `stats?type=custom` call (`Pdc`, `ac_loads`, `bp`, `bs`, `gp`). Tested live against the VRM
  demo installation (`VRM_DEMO=1`).
- **Growatt OpenAPI v1** — `plant/list → device/list → mix_last_data | tlx_last_data`. Implemented from the
  official docs and community libraries; field names vary by model, so the raw payload is retained for
  inspection. Verify against a live unit and log mismatches in `FRICTION_LOG.md`.

**Prior art:** a read-only [Victron VRM MCP server](https://github.com/gimi-q/victron-vrm-mcp) wraps the VRM API 1:1.
Powerline is not an API wrapper — the value is the forecast, the decision tools, cross-session household
memory, multi-vendor telemetry, and the interactive card.

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | `HOST=0.0.0.0` behind a tunnel |
| `ALLOWED_ORIGINS` | localhost only | comma-separated browser origins |
| `DATA_DIR` | `./data` | household store |
| `DEMO_USER_ID` | `demo-household` | stand-in for authenticated identity |
| `POWER_SOURCE` | `sim` | `sim` \| `victron` \| `growatt` |
| `SIM_ARRAY_KW` / `SIM_BATTERY_KWH` / `SIM_SPEED` | `4.5` / `10` / `60` | simulator; speed = sim-seconds per real second |
| `VRM_TOKEN` / `VRM_DEMO` / `VRM_SITE_ID` | — | Victron |
| `GROWATT_TOKEN` / `GROWATT_BASE_URL` / `GROWATT_PLANT_ID` / `GROWATT_DEVICE_SN` / `GROWATT_DEVICE_TYPE` | — | Growatt (type 5 = SPH, 7 = MIN) |
| `AWS_REGION` / `BEDROCK_MODEL_ID` | unset = disabled | e.g. `anthropic.claude-3-5-haiku-20241022-v1:0` |

## Roadmap (hackathon window)

- [x] Streamable HTTP sessions, MCP App dashboard, forecast engine, Victron + Growatt + sim adapters
- [ ] `plan_day` interactive planner card (toggle appliances, see runtime update via `callServerTool`)
- [ ] Server-initiated low-battery alerts over the GET SSE stream
- [ ] Per-household timezone (currently Africa/Lagos)
- [ ] Bedrock briefing enabled + documented; DynamoDB store option
- [ ] Demo video < 3 min, product feedback, friction log

## License

MIT
