# Product feedback

Written in first person from building Powerline between 8 September and 15 October 2026. One section
per tool, API or SDK, each answering the five questions the submission asks: what I used it for, what
worked well, what needs work, how onboarding felt, and whether I would build with it again.
Severity and dates for every "needs work" item are in [`FRICTION_LOG.md`](FRICTION_LOG.md).

---

## 1. MCP TypeScript SDK v2 — `@modelcontextprotocol/server` (Streamable HTTP, spec 2025-11-25)

**Used for:** the whole transport layer — `McpServer`, `WebStandardStreamableHTTPServerTransport`, one
server per session, the GET SSE stream for server-initiated notifications, `registerTool`,
`registerPrompt`, `sendLoggingMessage`. Also `@modelcontextprotocol/client` with `InMemoryTransport` in
tests.

**What worked well.** The sessionful transport is a clean fit for Hono's web-standard `Request`/`Response`:
`transport.handleRequest(req)` and nothing else. Session lifecycle hooks (`onsessioninitialized`,
`onsessionclosed`) are exactly where a per-session alert monitor wants to live. Zod schemas on tools
produce good `inputSchema` JSON for hosts and reject bad input before my code sees it. The in-memory
transport pair let me drive every tool through a real client in tests without a network. Typing is
strong enough that a renamed field fails the build, not the demo.

**What needs work.**
- `sendLoggingMessage()` **resolves successfully and sends nothing** unless the server declared
  `capabilities: { logging: {} }`. That is the worst class of bug — silent success — and it cost 45 minutes.
  Throw, or at least warn once.
- Notifications sent before the client opens its GET stream are **dropped without error**. My alerts had
  to learn to repeat while a condition persists. Document it in the Streamable HTTP section.
- The v1 → v2 package split (`@modelcontextprotocol/sdk` → `server` / `core` / `client`) is invisible from
  the hackathon resources and most tutorials. ext-apps 2.x peer-depends on v2, so `sdk` v1 fails with type
  errors on `registerAppTool` and nothing says why.
- v2 ships two protocol eras (2025-era sessions and the 2026-07-28 per-request path). `createMcpHandler`
  defaults to the newer one; the rules say 2025-11-25 "or later once confirmed". I used the sessionful
  transport directly to be safe. Say which is accepted.
- Elicitation works on 2025-era sessions but the API is already marked deprecated for 2026-07-28, the client-side
  registration form for spec methods differs from custom methods, and a client handler error surfaces on the
  server as a `'~standard'` message. One end-to-end example (server asks, test client answers) would fix all three.
- No guidance on CORS for browser hosts: the preflight carries no bearer token, so auth-before-OPTIONS
  returns 401 to the preflight and the real request never arrives; `Mcp-Session-Id` must be in
  `Access-Control-Expose-Headers`. Invisible from `curl`, fatal from a browser.

**Onboarding (zero → hello world):** about two hours, of which ninety minutes were the package split and
the logging capability. With the right package names and one paragraph about those two silent drops it
would be twenty minutes.

- MCP logging is **deprecated as of protocol 2026-07-28 (SEP-2577)**, yet on a 2025-11-25 session it is the
  only channel a server has for an alert nobody asked for. The replacement (`subscriptions/listen`) exists
  only on the newer era. A server that must support both has to send the same alert two ways. The docs
  should say what a 2025-era server should use for unsolicited alerts during the deprecation window.

- Credit where due: the client's **OAuth support worked first time** against my own spec-following
  authorization server — discovery from `resource_metadata`, dynamic registration, PKCE, `finishAuth`,
  refresh — with no reading beyond the `OAuthClientProvider` interface. That is how account linking should feel.

**Build with it again?** **Yes.** Once past the two silent failures the SDK did what it said; the
session model is small and the transport never crashed in four weeks of demos. I opened a docs PR for the two
drops because every server author will hit them; the PR link is in the Open Source section of the submission.

## 2. MCP Apps — `@modelcontextprotocol/ext-apps` v2

**Used for:** the dashboard, planner and report cards: `registerAppTool` / `registerAppResource` on the server,
the in-view `App` client (`ontoolresult`, `callServerTool`, `getHostContext`, `onhostcontextchanged`) in
the cards.

**What worked well.** Writing a *host* turned out to be a day's work, not a week's: `AppBridge` plus
`PostMessageTransport` handle initialize, tool-input/result delivery, size changes and card→server
`tools/call` forwarding when given an MCP `Client`; `getToolUiResourceUri` resolves the card for a tool. My
simulated Alexa+ host (`/demo`) is ~300 lines on top of that. Bidirectional calls are the feature: the planner card calls `plan_day` and
`arm_plan` on the server when the user ticks a box, and the round trip is well under a second in
MCPJam. `ui://` resources with `text/html;profile=mcp-app` are simple to serve from a cache. Host
context exposes the theme, so cards can follow the host rather than only the OS. The protocol is small
enough that a stubbed `App` class makes the views unit-testable in jsdom.

**What needs work.**
- A tool called by **both** a model and a card cannot tell who is calling. A small model sends
  `appliances: []` meaning "use everything"; the card sends `[]` meaning "nothing is ticked". I had to
  add an `exact` flag the card sets. A host-level "this call came from the UI" signal (or a documented
  convention) would remove a whole class of bug.
- The quickstart's `await app.connect()` at module top level fails Vite/esbuild's default target; the
  template should show the `.catch()` form or set the target.
- `vite-plugin-singlefile` only inlines one entry per build; real apps have several cards. A multi-view
  recipe in the templates would save every team the `UI_PAGE=card vite build && UI_PAGE=planner vite build` dance.
- When a card is opened outside a host (a judge double-clicks the HTML) `connect()` rejects with
  "Method not found". That is correct, but the quickstart should show rendering a readable message on it.

**Onboarding:** first card rendering in MCPJam in about an hour; the first *useful* card (card → server →
card) in an afternoon, most of it learning that the card re-renders from the `callServerTool` result,
not from a new tool result.

**Build with it again?** **Yes, enthusiastically.** A card that calls back into the server turns a chat
into a control surface; nothing else in the stack changes what an assistant can be as much as this.

## 3. MCPJam Inspector (`@mcpjam/inspector`) as the MCP Apps host

**Used for:** every manual test and the demo video — Add server → HTTP → `/mcp`, Tools / Prompts /
Resources tabs, the Playground with a hosted Claude Haiku 4.5, notifications panel for the alert stream.

**What worked well.** It renders MCP App cards and it shows the raw notifications, which is how I
proved the GET-stream alerts and armed reminders actually arrive. The hosted Playground model needs no
API key. Header support meant I could test per-household bearer tokens without writing a client.

**What needs work.**
- A fresh `npx @mcpjam/inspector@latest` failed on a transitive `@posthog/types` version (`ETARGET`);
  pinning an earlier release fixed it. Lockstep releases would avoid this.
- "Server did not become ready within 30 s" appears when the server is up but the browser tab opened
  late; the message blames the server.
- After a card calls `callServerTool`, the Playground shows a new tool row but the *original* card
  updates in place, higher up in the transcript — expected once you know, confusing the first time.

**Onboarding:** ten minutes to a rendered card once the package installed; the install hiccup added
twenty.

**Build with it again?** **Yes** — it is the only host I found that shows the card, the tool traffic and
the notification stream side by side, and that combination is what a server author needs.

## 4. Amazon Bedrock — Converse API (`@aws-sdk/client-bedrock-runtime`)

**Used for:** phrasing the evening briefing. The forecast engine computes the facts; Claude Haiku 4.5
(`us.anthropic.claude-haiku-4-5-20251001-v1:0`, us-east-1) turns them into one spoken paragraph under a
system prompt that forbids inventing numbers. Fifteen-second deadline, plain-facts fallback.

**What worked well.** The API itself was the easy part: a `ConverseCommand` with a system prompt and one
user turn, a few lines of SDK, correct on the first call once the account cleared verification. The
model ID from the console was right. `abortSignal` on `client.send` made the timeout trivial.

**What needs work.** All of it is account onboarding, none of it the API:
- A new account **cannot invoke any model for up to two hours** after sign-up (`AccessDeniedException:
  Your account is currently being verified`). The hackathon credit email should say so and tell people
  to redeem early.
- The **"Model access" console page has been retired** in favour of a Model catalog with a use-case form
  for Anthropic models. Every tutorial, including Amazon's, still says "enable model access".
- The sign-up's **Free account plan is not eligible for promotional credits**. The page does not say
  so. Choosing it would have cost the entire AWS Builder mini-challenge.

**Onboarding:** API — thirty minutes. Account, plan choice, credits, IAM user, verification wait — about
four hours spread over a day.

**Build with it again?** **Yes.** The Converse API is stable and model-agnostic, and the credits made
it free for this project. I would put a one-page "new account → first Bedrock call" checklist at the
top of the mini-challenge resources.

## 5. Amazon DynamoDB (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`)

**Used for:** the household store — one item per household, a `version` attribute, conditional
`PutItem` for optimistic concurrency, strongly consistent reads in the update cycle, retry with
exponential backoff and full jitter, records bounded below the 400 KB limit.

**What worked well.** Conditional writes behaved exactly as documented, which made the two-writer
problem (tool calls versus the alert monitor) a clean read-modify-write loop. On-demand billing meant
one `CreateTable` and no capacity planning. `lib-dynamodb`'s document client removed all attribute-type
boilerplate. The data survived restarts and the demo ("what appliances do you know about?" after a
restart) worked the first time.

**What needs work.**
- The document client marshals `undefined` as an error unless `removeUndefinedValues` is set; the error
  names the attribute but not the option. I normalise records myself now, but a hint in the error would
  save the search.
- `AmazonBedrockFullAccess` alone yields `AccessDeniedException` on the first DynamoDB call; nothing in
  the credit path says a second policy is needed. Powerline now turns that error into a message naming
  the table and the policy to attach.
- The IAM "create user" wizard re-ticked **console access** between screens, minting a password a
  server user never needs.

**Onboarding:** table and first write in under an hour, including the IAM policy detour.

**Build with it again?** **Yes.** For per-household state with concurrent writers it is the right
shape, and the cost at this scale rounds to zero.

## 6. Victron VRM API v2

**Used for:** live telemetry — one `stats?type=custom` call for `Pdc`, `ac_loads`, `bp`, `bs`, `gp` —
tested against Victron's public demo installation (site 219742) with `loginAsDemo`, and against a
personal access token path for real sites.

**What worked well.** Self-serve personal access tokens, a public demo user, a documented solar-forecast
endpoint, JSON that matches the docs, and rate limits generous enough for a demo. The best third-party
API I touched in this project.

**What needs work.** The demo user is forbidden from `diagnostics`, the endpoint the docs point at for
"current values"; `system-overview` returns metadata only. It took trial and error to find that
`stats?type=custom` works for the demo user. One line in the docs listing what the demo user can read
would fix it.

**Onboarding:** first real numbers in forty minutes.

**Build with it again?** **Yes.** Every inverter vendor should copy this API's onboarding.

## 7. Growatt OpenAPI v1 (ShinePhone token)

**Used for:** live telemetry — `plant/list → device/list → mix_last_data | tlx_last_data`, replay-tested
against recorded payloads for both device families (`test/fixtures/growatt/`). I do not own a Growatt
unit, so it has not been run against live hardware.

**What worked well.** A single `token` header, no OAuth dance, and the shape of the API (plant → device →
last data) is simple once known.

**What needs work.** The field names (`ppv`, `pLocalLoad`, `pcharge1`, `pdischarge1`, `pacToUserTotal`,
`soc`, …) **vary by model and firmware** and the only reference is a showdoc behind a Chinese-language
portal. Numbers arrive as strings on some units. There is no public schema and no sandbox. My adapter
tries several aliases and keeps the raw payload so a mismatch can be diagnosed from a log.

**Onboarding:** an afternoon of reading forum posts to build confidence in the mapping; no way to verify
without a device.

**Build with it again?** **Yes, with reservations** — it is the most common inverter brand in my market,
so it has to be supported; an English schema and a sandbox account would turn a day into an hour.

## 8. Open-Meteo forecast API (weather-aware solar)

**Used for:** hourly `shortwave_radiation` and `cloud_cover` for the household's coordinates, turned into
the next 24 hours of PV (`src/weather.ts`), replacing the clear-sky curve when `WEATHER_LAT/LON` are set.

**What worked well.** No key, no account, one GET, JSON with a `time` array alongside every series, and
a `timezone=UTC` parameter so the math stays in one clock. Response in well under a second.

**What needs work.** Hourly radiation is stamped with the *end* of its hour (the 13:00 value is the
12:00–13:00 average) while `cloud_cover` is instantaneous; the docs say so, but a reader skimming the
field table will index them the same way and ship a one-hour phase shift — I did, and a review caught
it. A `_preceding_hour` suffix on the averaged variables, or an `aggregation` field per series in the
payload, would make the distinction impossible to miss.

**Onboarding:** ten minutes from reading the docs to a working curve.

**Build with it again?** **Yes.** It is the right amount of API for the job; the fallback to clear-sky
means it can never take Powerline down.

## 9. Amazon ECS Express Mode (the live demo's host)

**Used for:** running the public instance judges can open — one Fargate task behind a managed load
balancer with an `https://…ecs.us-east-1.on.aws` URL, created by `scripts/deploy-ecs-express.sh` from
AWS CloudShell, pulling the image that GitHub Actions publishes to `ghcr.io`.

**What worked well.** One API call (`create-express-gateway-service`) replaces a VPC, load balancer,
target group, certificate and service definition; the URL is HTTPS out of the box; `x-forwarded-proto`
arrives so OAuth metadata advertises the right origin; the long-lived SSE stream survived 10 minutes
behind the balancer with the SDK's 15-second keep-alives. Rolling updates swap tasks without a gap.

**What needs work.** (1) The getting-started page's example passes `--cpu 2 --memory 4` while the API
wants CPU units and MiB (`1024`/`2048`) — the first attempt fails with "Invalid CPU/Memory combination".
(2) `--monitor-resources` assumes a TTY and prints an error in CloudShell unless `--monitor-mode
TEXT-ONLY` is added. (3) The service reports ACTIVE minutes before its DNS name resolves, so a script
has to poll the URL, not the status. (4) Response headers on an SSE `GET` are held until the first body
byte reaches the balancer (~15 s here) — a host with a short connect timeout would misread that as
"down". (5) There is no "from a public GitHub image" example, which is the shape most hackathon
projects have.

**Onboarding:** an evening, most of it discovering that App Runner had closed and that the Express
Mode docs' units example was wrong; after that, redeploys are one line.

**Build with it again?** **Yes.** It is the right size for a single-container service, and the
friction above is all documentation.

## 10. Hackathon resources and the Alexa+ track documentation

**Used for:** deciding what to build and which protocol version to target.

**What worked well.** The rules are precise about the runtime-technology requirement (an import and a
call, not a README mention), and the "obvious vs creative" examples in the judging criteria told me
exactly what to aim for: bidirectional cards, state across sessions, an assistant that acts.

**What needs work.** The Alexa+ resources link the MCP spec but not the v2 SDK packages or an MCP Apps
example; a combined Streamable HTTP + MCP Apps starter would have saved every team on this track a day.
"Spec 2025-11-25 or a later version, once confirmed" should be resolved now that 2026-07-28 ships in
the SDK. The credit email could carry the three AWS account notes above.

**Onboarding:** the live Build Session was the most useful hour; the written resources needed the
package names.

**Build on this track again?** **Yes.** The combination of an open protocol, cards, and a real device
audience is the first time I have wanted to ship a voice integration.

---

## Summary for the AWS Builder mini-challenge

AWS services used, as required by the mini-challenge rules: **Amazon Bedrock** (Converse API, Claude
Haiku 4.5 on an inference profile, `src/bedrock.ts`) phrases the evening briefing from engine-computed
facts, with a deadline and a plain-facts fallback; **Amazon DynamoDB** (`src/store/dynamo.ts`) holds
per-household state with conditional writes, strongly consistent reads, jittered retries and bounded
records. Both are exercised at runtime (`npm run start:aws` with `STORE=dynamodb` and
`BEDROCK_MODEL_ID` set) and the integration is documented in the README's *Store* and *Environment*
sections. The judges' live instance runs on **Amazon ECS Express Mode** (section 9) with a task role for
Bedrock; App Runner, the first plan, closed to new customers in April 2026 — see the friction log.
