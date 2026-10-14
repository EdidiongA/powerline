# Changelog

All work below happened inside the hackathon submission window (31 Aug – 23 Oct 2026). The repository was created on 9 September 2026; nothing pre-dates it.

## 0.13.2 — 12 Oct 2026
- **Free-form requests in the simulated host.** Found on the live demo: without Bedrock, "give me a brief of what it looks like by tomorrow morning" and "do all of them" both got the same menu. The no-model router now understands briefings and "will it last" phrasings, lets planning win over time words, knows more status synonyms, and turns "do all of them / give me everything / full rundown" into four read-only tools in one turn (never arming anything); an unknown request gets concrete example phrasings instead of a vague menu. The Bedrock system prompt gets the same mapping and is told never to answer with only a menu. Router tests cover both original sentences verbatim; the headless-browser check asks them on every push. 112 tests.

## 0.13.1 — 10 Oct 2026
- Fix: the server's own `/demo` page was refused with "Forbidden origin" on a public deployment (the Origin check only knew localhost and `ALLOWED_ORIGINS`); same-origin requests, judged through the forwarded headers, are now always allowed. Found on the first ECS deploy; tested.
- Deploy path moved from AWS App Runner (closed to new customers since April 2026) to **Amazon ECS Express Mode**: `.github/workflows/image.yml` publishes the image to GitHub's registry on every push; `scripts/deploy-ecs-express.sh` creates the roles and the service from AWS CloudShell and prints the public HTTPS URL. `apprunner.yaml` and the App Runner script removed.

## 0.13.0 — 8 Oct 2026
- **OAuth 2.1 account linking** (`src/oauth.ts`): protected-resource and authorization-server discovery, dynamic client registration (public clients; loopback/https redirects), consent page, authorization-code grant with mandatory PKCE S256 and single-use codes, rotating refresh tokens, `resource_metadata` on every 401. The official MCP client completes the whole flow in `test/oauth.test.ts`; negative cases covered.
- **Weather-aware solar** (`src/weather.ts`): Open-Meteo shortwave radiation for `WEATHER_LAT/LON` becomes the PV forecast (performance ratio 0.8), cached, deadline-bounded, falling back to the clear-sky curve; the dashboard footer says which source is in use.
- Hardened after a second-pass review: errors for a trusted client+redirect bounce back to the client with `state` (RFC 6749 §4.1.2.1); RFC 8707 `resource` audience checked on authorize and token; `client_id` required on refresh; `error="invalid_token"` on expired tokens so hosts refresh instead of re-linking; consent lockout after ten wrong secrets per household in a bounded table that junk names cannot flush; registration and consent rate-limited; byte-counted body ceilings on every unauthenticated endpoint (chunked bodies included); consent page `no-store` and un-frameable; `/oauth/token` accepts JSON as well as form bodies; misconfigured TTLs fall back to defaults instead of "forever". `PUBLIC_URL` / `x-forwarded-*` decide the advertised origin behind a proxy.
- Weather: Open-Meteo's end-of-hour radiation stamps indexed correctly (no one-hour phase shift); an outage is retried every three minutes, not on every tool call; blank `WEATHER_LAT/LON` mean unset. IPv6 loopback accepted as a dev origin.
- Second fresh-eyes review of the host and engine, all fixed: the simulated host rolls a failed turn back so Bedrock never sees two user messages in a row, and the server repairs any non-alternating history anyway (`repairHistory`, tested); the host reconnects by itself after a server restart or a reaped session and retries the call (checked in headless Chromium); half-hour time zones (India, Adelaide) keep exact clocks and never NaN a forecast; "last 7 days" is seven local days, not eight; a plan armed between an alert tick's read and write can no longer be wiped; an elicitation that times out keeps the armed plan (silence is not consent); hourly sampling checks the whole history, not just the tail; non-numeric interval/timeout settings fall back to defaults; the mic stays disabled where speech recognition is missing; old cards are closed past twenty so a long session stays light.
- `/healthz` reports auth mode and OAuth stats. 111 tests.

## 0.12.1 — 8 Oct 2026
- README rebuilt above the fold: badges, an animated capture of the host, an "at a glance" table; `docs/overview.png` for galleries.
- Landing page leads with the simulated host. `scripts/deploy-apprunner.sh`: one-command App Runner deploy from GitHub that prints the live `/demo` URL and a judge token.

## 0.12.0 — 8 Oct 2026
- **Simulated Alexa+ host** at `/demo` (`src/ui/demo.ts`, `src/demo/`): a complete MCP Apps host in one page — real Streamable HTTP client, cards through the SDK's `AppBridge` in sandboxed iframes with card→server calls, pushed alerts and reminders as toasts, elicitation answered with a confirm, voice in (Web Speech) and out (speechSynthesis), theme toggle propagated to cards, token dialog when the server requires one. Model step via `/demo/llm`: Amazon Bedrock Converse with the server's tools when configured, else a deterministic phrase router (`src/demo/router.ts`, tested); same auth as `/mcp`, rate-limited, size-bounded.
- **Appliance presets** (`src/presets.ts`): twenty common appliances with aliases, so `add_appliance` and `can_i_run` work without a wattage and say what they assumed.
- **Per-household timezone**: `setup_system … tzOffset` drives local hours, labels, reports and reminder text; the server `TZ_OFFSET` remains the default.
- `/healthz` reports `llm` and `version`. 106 tests, plus browser-level verification of the host (cards, card→server re-plan, elicitation dialog, reminder toasts, token mode).

## 0.11.2 — 8 Oct 2026
- Landing page no longer prints the store's filesystem path (tested); README seeding note for the compose clock; `.gitattributes` keeps LF line endings on Windows checkouts.

## 0.11.1 — 8 Oct 2026
- Records are **sanitised on read** as well as on write (both stores): a hand-edited `store.json`, a legacy record or a bad DynamoDB item (string profile fields, NaN samples, non-numeric version) can no longer crash a tool call; a broken profile falls back to the default rather than poisoning the forecast.
- Learning ignores dead readings (0 W in and out) and floors the solar yield factor at 25 % of clear-sky, so a broken adapter cannot teach the forecast that the sun never rises; `outage_outlook` is NaN-safe on an unparseable telemetry time.
- Fuzz suite: 350 hostile calls across every tool with flaky telemetry (NaN, bad timestamps, thrown errors) — no crash, no hang, server still correct afterwards. 99 tests.

## 0.11.0 — 8 Oct 2026
- **History and learning.** The alert monitor records one sample per hour per household (bounded to 14 days, one write per hour slot across sessions). `src/history.ts` (pure): daily reports, period slicing, learned load shape (per-hour median after 3 full days), learned PV yield factor, autonomy hours. `situation.ts` uses the learned curves when available.
- New tools: `energy_report` (third MCP App card with today / yesterday / week tabs; cost and solar value when a tariff is set), `outage_outlook`, `set_tariff`. New prompt `how_did_we_do`. Resource `powerline://household`. MCP annotations on every tool.
- `npm run seed:history` seeds a week of plausible readings for demos.
- Views escape quotes as well as angle brackets; card tests now strip the bundle correctly and check for real markup/attribute injection.
- 96 tests.

## 0.10.0 — 8 Oct 2026
- `arm_plan` asks before replacing an already-armed plan when the host supports **MCP elicitation**; proceeds (and says so) on hosts that cannot ask; the planner card's own path never asks because it has a Re-arm button. Tested both ways.
- `apprunner.yaml`: deploy from the GitHub repo to AWS App Runner without a container build; `docs/DEPLOY.md` walks through it.
- README: "What is real and what is simulated".

## 0.9.3 — 8 Oct 2026
- `@modelcontextprotocol/client` (test dependency) bumped past GHSA-6qxp-vccf-f47h; `npm audit --omit=dev` is clean.

## 0.9.2 — 6 Oct 2026
- Product feedback trimmed to tools actually used; friction-log entry on MCP logging being deprecated for 2026-07-28 (SEP-2577) while remaining the only unsolicited-alert channel on 2025-11-25; README notes the alerts are structured so the delivery call can change without the feature changing.

## 0.9.1 — 5 Oct 2026
- End-to-end suite: the official MCP client drives a real Powerline process over Streamable HTTP through the README sequence — cards as resources, prompts, planner `exact` semantics, arming, **a reminder arriving on the notification stream**, persistence across sessions, two concurrent sessions of one household, token isolation.
- Product feedback written out per tool (SDK, MCP Apps, MCPJam, Bedrock, DynamoDB, VRM, Growatt, track docs).
- README: "track requirement at a glance" table pointing at the exact runtime call sites.

## 0.9.0 — 2 Oct 2026
- MCP **prompts** (`prompts/list`): `evening_outlook`, `plan_my_day`, `can_i_run`, `set_up_household`.
- **Agent Skill** `skills/powerline-home-power/SKILL.md` (agentskills.io format): how an agent should drive the tools, relay reminders and phrase answers.
- GitHub Actions CI: build + 109 tests on Ubuntu and Windows, Docker image build with a `/healthz` probe.
- README: card screenshots, architecture diagram, deployment guide for a public Alexa+-reachable endpoint (`docs/DEPLOY.md`).

## 0.8.0 — 30 Sep 2026
- Property tests over 1,500 random households (SOC bounds, monotonicity, inverter and reserve invariants).
- Landing page at `/`; `MAX_SESSIONS` and 1 MB body ceilings; simulator follows `TZ_OFFSET`; NaN-safe env parsing.
- `plan_day` blames the inverter, not the battery, when an appliance is simply too large.

## 0.7.x — 26 Sep 2026
- Planner `exact` semantics (untick-all means nothing, not everything); `remove_appliance`; default-profile hint.
- CORS preflight answered before auth; `Mcp-Session-Id` exposed; instant shutdown.
- Upstream timeouts on VRM, Growatt and Bedrock; Bedrock plain-facts fallback; 6 h session TTL so armed reminders survive silence.
- Cards follow the host theme; busy state disables keyboard input; error/cancel/connect-failure states.
- Per-household bearer tokens (fail-closed), session ↔ household binding; Growatt replay fixtures; Dockerfile + compose.

## 0.5.0 – 0.6.1 — 20–24 Sep 2026
- DynamoDB store with conditional writes, retry with jitter, bounded records; Amazon Bedrock briefing.
- `arm_plan`: server-pushed reminders at each appliance's start time.
- Architecture split into `config` / `situation` / `tools/*` / `views` / `alerts`.

## 0.1.0 – 0.4.0 — 9–19 Sep 2026
- Streamable HTTP MCP server (spec 2025-11-25) with sessions and the GET SSE stream.
- Forecast engine, `can_i_run`, `plan_day`; Victron VRM and Growatt adapters; simulator.
- MCP App dashboard and interactive planner cards; server-initiated low-battery and grid alerts.
