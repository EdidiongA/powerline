# Changelog

All work below happened inside the hackathon submission window (31 Aug – 23 Oct 2026). Work began on 8 September 2026 and the public repository on 9 September; the visible git history starts at the v0.6.1 baseline commit of 26 September, with every earlier version listed below. Nothing pre-dates the hackathon.

## 0.14.0 — 19 Oct 2026
- **Prepaid units: Powerline can now buy electricity, after the household says yes.** Three tools. `set_meter` verifies a prepaid meter with the vendor before saving it. `prepaid_units` estimates the balance (the last meter reading minus the grid energy Powerline recorded since), says when the units run out while the grid is carrying the house, and re-runs the battery forecast without the grid from that hour. `buy_units` buys a top-up and returns the 20-digit token, also pushed as an alert. The evening briefing mentions the units when they will run out. Vendors sit behind one interface (`src/vending.ts`): a simulated vendor by default (no network, no money, and every reply says so), or VTpass's bill-payment API, sandbox only unless `VTPASS_ALLOW_LIVE=1`.
- **Money safety, all tested:**
  - nothing is bought without an explicit yes, through MCP elicitation, or through a 5-minute quote on hosts without it;
  - a declined, cancelled, timed-out or unreadable answer buys nothing;
  - ceilings per purchase and per rolling 24 hours are checked inside the same conditional write that records the purchase;
  - the purchase is stored as pending under a fresh Lagos-time VTpass request id before the vendor is called;
  - an unclear answer is re-queried with that id, never bought again;
  - the Strands agent is never handed `buy_units`.
- The simulated host asks its questions in its own yes/no dialog instead of the browser's `confirm()`, and fills every boolean the server asks for (so the same dialog serves "replace the armed plan?" and "buy ₦5,000 of units?"). New hint chips for the meter, the units outlook and a purchase. The offline phrase router understands "buy 5,000 naira of units", "recharge 5k", "buy light", "my meter is …, Ikeja Electric, 3 units left" and "do I need to buy units?".
- **Review before release:** a separate reviewer went over the new code and found five bugs, all fixed and tested:
  - A requery could mark an in-flight purchase as failed and lose its token. Requeries now wait until the vendor call has finished, distrust an early "failed", and the vendor's own "delivered" always wins.
  - Purchase history was trimmed by count, so many small purchases could slip under the 24-hour ceiling. It is now trimmed by age, and today's purchases are never dropped.
  - A token that arrived after a "processing" answer was saved but never told to the household. It is now told once, in the reply and as a pushed alert.
  - Two problems in the confirmation dialog: focus started on Yes, so a stray Enter could confirm, and the dialog stayed open after the server gave up. Focus now starts on No, Yes is inert for half a second, and the dialog closes on cancellation or expiry.
  - VTpass token parsing could glue a kWh figure onto the token, and `tokenAmount` (naira) could be read as kWh. The token is now taken as exactly 20 digits.
  - Smaller fixes: the DisCo's minimum purchase is stored and enforced; correcting the DisCo keeps the balance; grid use since a reading neither skips an on-the-hour reading nor double-counts the current hour; a storage failure after a vend still hands over the token; and offline router phrasings that had been captured by the new rules ("each unit costs 225", "units we used yesterday", "buy a 10k battery") route as before.
- **Third pass:** a black-box probe of the running server and an audit of every document against the code. Fixes:
  - A purchase confirmed late, without a units figure from the vendor, is now credited to the balance.
  - Units bought while the previous balance was unknown are reported as "at least".
  - Clearer wording when the meter is already empty and when the reserve is 0 %.
  - A non-naira tariff is named instead of silently ignored, and currencies are stored in upper case.
  - `remove_appliance` names are bounded.
  - The offline router understands plain-number purchases ("top up my meter with 5000", "buy 5000"), "add 5000 naira to my meter" and "units finished".
  - The deploy script passes the simulator settings through, and the docs are corrected to match.
- **Fourth pass** (a review of the latest changes, and a full rehearsal of the video guide in a headless browser):
  - The offline router never treats "light is out" as an empty meter (in Lagos it means an outage). It never reads a spaced meter number, an airtime top-up or a phone number as a naira amount.
  - Tariffs stored as "naira" or "₦" before currencies were normalised still count as naira.
  - In the simulated host:
    - prepaid tokens never wrap mid-code;
    - `?clean` hides the example chips for filming and screenshots;
    - the model pill reads "phrase router (offline)" when Bedrock isn't configured;
    - card and tool calls wait up to 150 s, so a purchase confirmed late still shows its reply.
- 165 tests (29 new for units, vendors and the three tools; router cases; the agent never sees `buy_units`), and the headless browser check now buys units through the dialog and waits for the token toast. Two new friction-log entries (purchasing guidance on Alexa+; VTpass documentation) and a VTpass section in the product feedback.

## 0.13.7 — 19 Oct 2026
- **Alerts moved off the deprecated channel.** Reminders, low-battery and grid alerts are now appended to a per-session `powerline://alerts` resource, and hosts that subscribe (`resources/subscribe`) are told through `notifications/resources/updated`, which is current in protocol 2025-11-25 and maps onto the `resource_updated` event 2026-07-28 carries over `subscriptions/listen`. MCP logging (deprecated in 2026-07-28, SEP-2577) remains only as the fallback for hosts that don't subscribe, so nothing that worked stops working. Every alert carries the same id on both paths, so a host that subscribes after hearing an alert over logging never shows it twice; only `powerline://alerts` can be subscribed to. The simulated host subscribes. End-to-end tests with the official client cover both paths and the late-subscriber case; the headless browser check asserts the host subscribed and read the alerts resource. 136 tests.
- **An agent that plans the day on its own.** `agent/` adds an autonomous evening agent built with the Strands Agents SDK on Amazon Bedrock: it uses Powerline's MCP tools over Streamable HTTP to check the battery and the outage outlook, plan tomorrow and arm the plan, then writes one paragraph. Packaged as an Amazon Bedrock AgentCore Runtime app too (tested locally against its HTTP contract, not deployed). A Python test drives the agent with a scripted model against a real Powerline process and asserts the plan is armed on the server; it runs as its own CI job. The server is unchanged by this.

## 0.13.6 — 17 Oct 2026
- Last sweep before submission: two fresh reviewers over the server and the browser pages, then a third over the fixes themselves. Fixed: **cards rendered before a redeploy went dead** (the bridge was bound to the old client; card calls now go through the host's reconnect-aware path, and the headless check ticks a pre-restart card after restarting the server); the planner's *Arm plan* button was re-enabled after every re-plan even with nothing ticked, and clicking it then silently disarmed; a `get()` racing the disk store's very first read could persist a stale snapshot over a committed write (one in-flight read is now shared; a failed write no longer leaves the cache ahead of the file; `__proto__` is an ordinary household id); `sanitize()` lets a timestamp like `+275760-…` through, after which every tool for that household threw (timestamps are now bounded to ±200 years and canonicalised; appliance and armed-item numbers are bounded like the tools bound them); a blank `TZ_OFFSET=` line in `.env` silently moved the household to UTC, and garbage in `SESSION_TTL_MS`, `MAX_SESSIONS`, `PORT` or `DYNAMO_MAX_ATTEMPTS` disabled the limit or broke every Dynamo call; `/demo/llm` was not byte-counted (a chunked body bypassed the 200 kB ceiling) and a `null` content block was reported as a Bedrock outage; rate limits are per caller with a global ceiling a forged `X-Forwarded-For` cannot lift; the Victron adapter reported zero grid flow as an outage (now *unknown*; see the friction log); the briefing said "reserve reached in 0.0 h" when already below it; `setup_system` accepted a 1e-9 kW inverter. Host page: toasts and the thinking line are announced to assistive tech; the token dialog submits on Enter, says when a token was refused, can be reopened from the header pill and cannot trap the user; a reply from the model endpoint is validated before use; theme changes go through `setHostContext`; no horizontal scroll at phone width; the oldest cards say when they have gone static. The browser pages are now type-checked strictly (`tsconfig.ui.json`) as part of every build — the check that would have caught the theme-toggle bug; the reported version is pinned to package.json by a test. `SIM_STEADY=1` removes the simulator's reading-to-reading wobble so a demo or a recording gives the same answers every time (found while scripting the video: at the edge of the reserve, ±10 % load noise flipped "holds through the night"). 134 tests.

## 0.13.5 — 16 Oct 2026
- Final sweep, three reviewers (engine and tools under hostile input; submission-rules audit including every claim in the video script; a second black-box probe of the live deployment). Fixed: **Victron VRM stamps samples in epoch milliseconds**, which the adapter multiplied by 1000 — every live reading was dated year 58759, rotating the forecast and breaking reports on the Victron path (now accepts ms or s and never a date more than a week off; a payload with no state of charge is served as the last good reading, not 0 %, in both the Victron and Growatt adapters); `can_i_run` / `plan_day` refused or misblamed appliances when the battery was already heading under the reserve but the grid or the sun would carry the run — the common Lagos evening after an outage; DynamoDB records written before versioning could never be updated again; armed start times are anchored to the top of the hour so "iron at 08:00" is never reminded at 08:50; the arming session heard a run-now reminder twice; `sanitize()` threw on non-array collections in a hand-edited store; a grid event dated in the future or the distant past blocked every later event; the dashboard clock in half-hour zones; grid-availability for the hours past midnight now uses tomorrow's weekday; tiny appliances rounding to 0 W; a 101 kW inverter read as 0.101 kW; a malformed elicitation answer no longer counts as consent; Bedrock briefing tolerates a reasoning block first and a bad timeout setting; the simulated host queues model calls (at most three in flight) and retries throttles twice with back-off; `outage_outlook` reports no reserve time when the reserve is never reached; `npm run seed:history` reads `.env` like the server; the host's reply label is "Assistant · Powerline" and the model is told it speaks for a simulated host; favicon. 126 tests.

## 0.13.4 — 15 Oct 2026
- Third fresh-eyes sweep (three reviewers: a judge reading the repo, a code reviewer, and a black-box probe of the live deployment), all fixed: **reminders are delivered to every open session** — `firedAt` was being used as a delivery receipt, so with two hosts open only one heard the 08:00 push (e2e test added with two sessions); the 1 MB `/mcp` body ceiling now counts bytes, so a chunked body cannot bypass it; the landing page advertises the public origin behind the load balancer; `/healthz` no longer prints a filesystem path; the rules router caps utterance length (a 60k-character request used to stall the event loop for ten seconds) and routes "note NEPA took light", "cancel everything", "could you run the energy report" and "switch off the fridge" correctly; `repairHistory` can no longer leave two assistant turns adjacent; the host trims before it marks a turn for rollback; the simulated inverter sheds load at the cut-off instead of drawing power from nowhere; seeding settles before the recorder starts; the deploy script re-attaches IAM policies on every run and the image workflow also fires on `master`; `outage_outlook` names its hour fields unambiguously; `log_grid_event` carries its annotation. Docs brought in line (three cards, ECS Express, 26 friction entries, recorder). 119 tests.

## 0.13.3 — 15 Oct 2026
- Bedrock: a throttled call is retried once after a short pause instead of surfacing as a 503 (seen when probing the live demo with nineteen prompts in a burst); the model is told to log a reported grid flip before giving the outlook, and that "switch off X" is not something it can do.
- **History no longer depends on an open session.** Found on the live demo: "last 7 days" showed two days because readings were only taken while someone had the host open. A server-level recorder (`src/recorder.ts`) now samples every household once an hour and logs grid flips whether or not anyone is connected; the session monitors keep doing the same, idempotently. With simulated telemetry, `SEED_HISTORY_DAYS=7` gives a household with no readings a week of plausible history ending where the simulated clock starts (`src/seed.ts`; the deploy script sets it), so a fresh deployment reports and learns from minute one. The simulated inverter now has a low-battery cut-off (`SIM_CUTOFF_SOC`, default 10 %) instead of flattening the battery to 0 %. The report card draws all seven day slots, dimming days without readings and saying "readings on N of 7". 115 tests.

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
- GitHub Actions CI: build + 81 tests on Ubuntu and Windows, Docker image build with a `/healthz` probe.
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
