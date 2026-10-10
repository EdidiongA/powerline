# Friction log

Format per entry: task → steps → expected vs actual → severity (Blocker / Major / Minor) → workaround → suggestion.
Judges award up to 10% bonus for these. Log as you go; don't reconstruct at the end.

## 2026-09-08 — SDK package split not reflected in hackathon links
- **Task:** Install the MCP TypeScript SDK to build a Streamable HTTP server.
- **Steps:** `npm install @modelcontextprotocol/sdk` (v1.30) then `@modelcontextprotocol/ext-apps` (v2.0).
- **Expected:** The two packages interoperate.
- **Actual:** ext-apps 2.x peer-depends on the new split packages (`@modelcontextprotocol/server`, `core`, `client` v2), not `sdk` v1. Type errors on `registerAppTool(server, …)`.
- **Severity:** Major (cost ~30 min).
- **Workaround:** Uninstall `sdk`, install `@modelcontextprotocol/server@^2`; use `WebStandardStreamableHTTPServerTransport` + Hono.
- **Suggestion:** Hackathon resources page should name the v2 packages explicitly and link a Streamable HTTP + MCP Apps combined example.

## 2026-09-08 — v2 SDK ships two protocol eras
- **Task:** Confirm which spec version the server negotiates.
- **Actual:** `@modelcontextprotocol/server` v2 introduces a "modern" 2026-07-28 per-request era alongside "legacy" 2025-era sessions; `createMcpHandler` defaults to the modern path. The hackathon minimum is 2025-11-25, so sessionful `WebStandardStreamableHTTPServerTransport` was used directly.
- **Severity:** Minor (documentation).
- **Suggestion:** Rules should state whether 2026-07-28 submissions are acceptable ("or a later version, once confirmed" is ambiguous).

## 2026-09-08 — MCP App view build: top-level await
- **Task:** Bundle the view with Vite + vite-plugin-singlefile.
- **Actual:** `await app.connect()` at module top level fails esbuild's default target.
- **Severity:** Minor.
- **Workaround:** `app.connect().catch(console.error)`.
- **Suggestion:** ext-apps quickstart should show the non-top-level-await form or set `build.target: "esnext"` in the template.

## 2026-09-08 — VRM demo user cannot read `diagnostics`
- **Task:** Get live PV/load/SOC from the Victron VRM demo installation.
- **Steps:** `loginAsDemo` → `installations/{id}/diagnostics`.
- **Expected:** Current attribute values (documented endpoint).
- **Actual:** `forbidden` for the demo user; `system-overview` returns device metadata only.
- **Severity:** Minor.
- **Workaround:** `stats?type=custom&attributeCodes[]=Pdc&…&ac_loads&bp&bs&gp` returns the last 15-min values.
- **Suggestion:** VRM docs list which endpoints the demo user can access.

## 2026-09-08 — Growatt OpenAPI v1 payload field names undocumented in one place
- **Task:** Map `mix_last_data` / `tlx_last_data` to PV / load / SOC / battery / grid.
- **Actual:** Field names (`ppv`, `pLocalLoad`, `pcharge1`, `pdischarge1`, `pacToUserTotal`, `soc`…) vary by
  model/firmware; the official showdoc pages are the only reference and are behind a Chinese-language portal.
- **Severity:** Major (blocks confident mapping without a live unit).
- **Workaround:** Adapter tries several aliases and keeps `raw` for inspection.
- **Suggestion:** Growatt publish an English OpenAPI schema; hackathon resources could link it.

## 2026-09-09 — `sendLoggingMessage()` is a silent no-op without the `logging` capability
- **Task:** Push low-battery alerts to the client over the GET SSE stream.
- **Steps:** `server.sendLoggingMessage({level:"warning", data})` from a background timer.
- **Expected:** A `notifications/message` frame on the stream, or an error.
- **Actual:** Resolves successfully and sends nothing unless `new McpServer(info, { capabilities: { logging: {} } })`. Cost ~45 min.
- **Severity:** Major.
- **Workaround:** Declare the capability. Also: notifications sent before a client opens its GET stream are dropped silently, so alerts must repeat while the condition persists.
- **Suggestion:** Throw (or at least warn) when the capability is missing; document the drop-before-GET behaviour in the Streamable HTTP section.

## 2026-09-09 — vite-plugin-singlefile: one entry per build
- **Task:** Bundle two MCP App views (dashboard + planner) into two self-contained HTML files.
- **Actual:** `output.inlineDynamicImports` rejects multiple inputs.
- **Severity:** Minor.
- **Workaround:** Run vite once per page (`UI_PAGE=card`, `UI_PAGE=planner`) via `cross-env`.
- **Suggestion:** ext-apps templates could ship a multi-view build recipe.

## 2026-09-15 — New AWS accounts cannot invoke Bedrock for up to 2 hours
- **Task:** Call Claude on Bedrock after redeeming the hackathon credits.
- **Steps:** Sign up → redeem $150 → Bedrock → Model catalog → submit Anthropic use-case form → playground → "hello".
- **Expected:** A response, since the use-case form had been accepted.
- **Actual:** `AccessDeniedException: Your account is currently being verified. Verification normally takes less than 2 hours.`
- **Severity:** Major for a timed event — a participant who redeems credits on submission day cannot use Bedrock that day.
- **Workaround:** Wait; it cleared within the stated window.
- **Suggestion:** The hackathon credit email should say that new AWS accounts need verification before Bedrock calls succeed, and advise redeeming early.

## 2026-09-15 — AWS "Free" account plan silently disqualifies promotional credits
- **Task:** Create an AWS account to redeem the hackathon credits.
- **Actual:** Sign-up offers Free vs Paid plans. The Free plan is documented as not eligible for other promotional credits and discounts, so redeeming the hackathon code there would have failed; the page itself does not say this.
- **Severity:** Major (would have cost the whole AWS mini-challenge).
- **Workaround:** Choose the Paid plan — still no charge while credits cover usage.
- **Suggestion:** The credit email should state "choose the Paid account plan" for new accounts.

## 2026-09-15 — IAM create-user wizard re-enables console access
- **Task:** Create a programmatic-only IAM user for the server.
- **Actual:** The "Provide user access to the AWS Management Console" checkbox became ticked between screens, adding a console password the user never needs and a 4th wizard step.
- **Severity:** Minor, but it mints an unnecessary long-lived credential by default.
- **Workaround:** Untick before Next, or disable the password afterwards via Security credentials → Manage console access.
- **Suggestion:** Default that checkbox off when the flow began from "access key" intent.

## 2026-09-15 — Bedrock and DynamoDB need separate IAM policies, and the docs for the credit path don't say so
- **Task:** Give one IAM user the permissions Powerline needs for both AWS services.
- **Actual:** `AmazonBedrockFullAccess` alone yields `AccessDeniedException` on the first DynamoDB call, with no indication which permission is missing until you read the error's service name.
- **Severity:** Minor, but it costs a debugging cycle for anyone adding a second AWS service.
- **Workaround:** Attach `AmazonDynamoDBFullAccess` as well; Powerline now turns that failure into a message naming the table and the policy to attach.
- **Suggestion:** The AWS Builder mini-challenge guidance could list the policies a typical multi-service submission needs.

## 2026-09-20 — `spawnSync npx ENOENT` on Windows
- **Task:** Run the card render tests on the Windows laptop after they passed on Linux.
- **Actual:** Node's `execFileSync("npx", …)` fails with ENOENT on Windows because the executable is `npx.cmd`; six tests failed, all in the harness, none in the cards.
- **Severity:** Minor, but it makes a green suite look red on the platform most entrants use.
- **Workaround:** Call esbuild's JS API (`buildSync`) instead of spawning a CLI.
- **Suggestion:** None for Amazon — this is a Node-on-Windows quirk — but it belongs in the log because it cost a debugging cycle on the day I wired up AWS.

## 2026-09-22 — A reminder scheduled for "now" was never delivered
- **Task:** Arm a plan whose first appliance is due immediately, and see the reminder arrive.
- **Actual:** The background monitor's first tick after arming had no earlier reading to measure elapsed time from, so its 20-minute tolerance window had already closed. Nothing fired; no error anywhere.
- **Severity:** Major for the feature (silent), minor for the platform — this was my own logic, not the SDK.
- **Fix:** Items due at arm time are announced from the tool call itself; the monitor's first tick uses a one-hour window; subsequent windows stretch to cover whatever elapsed since the last tick (covers a sleeping laptop and a fast simulated clock alike).
- **Lesson worth sharing:** time-based agent behaviour needs a test that advances the clock; a passing unit test on the "is it due?" predicate said nothing about whether the loop around it would ever see the moment.

## 2026-09-23 — A missing telemetry field would have poisoned every forecast point
- **Task:** Trace what happens when an adapter reports a field it could not read.
- **Actual:** `NaN` state of charge flows into the SOC integration; `Math.min(100, Math.max(0, NaN))` is `NaN`, so all 24 forecast points and every downstream decision become `NaN` — with no error. The dashboard would render "NaN%".
- **Severity:** Major (silent, and Growatt field names vary by model, so it is a realistic input).
- **Fix:** Telemetry is coerced to finite numbers in one place (`situation.ts`) before any consumer sees it; a test now feeds NaN through and asserts every forecast value is finite.
- **Lesson:** every adapter boundary needs a normalisation step that owns "what does missing mean"; leaving it to each consumer guarantees one of them forgets.

## 2026-09-26 — Bearer auth that fails open on a typo
- **Task:** Turn a single shared token into per-household tokens so two households can share one server.
- **Actual (my own first cut):** If `API_TOKENS` was set but every entry was malformed, the parser produced zero credentials and the endpoint treated "no credentials" as "auth not configured" — i.e. open. A typo in an environment variable would have silently exposed every tool.
- **Severity:** Major (security), caught by writing the test for the "all entries bad" case before shipping.
- **Fix:** "Configured" is decided by whether the variable is set, not by whether anything parsed. Set-but-broken now rejects every request and says so in the startup line.
- **Lesson worth logging:** authentication code needs a test for the misconfigured state, not only the wrong-token state; the two look identical from inside the parser.

## 2026-09-26 — Rounding half toward +∞ in a grid-export figure
- **Task:** Replay a recorded Growatt payload with `pacToGridTotal = 1897.5` W.
- **Actual:** The adapter reported −1897 W; the fixture expected −1898. Both are "right": JavaScript's `Math.round` rounds .5 toward +∞, so −1897.5 → −1897. The adapter was fine; the expectation was wrong.
- **Severity:** Minor, but the kind of thing a reviewer "fixes" into a bug. Documented in the test.
- **Suggestion:** none for Amazon; noted because inverter APIs return half-watt values constantly and sign-sensitive rounding is easy to get wrong in either direction.

## 2026-09-26 — Two callers send `[]` with opposite meanings
- **Task:** Untick every appliance on the planner card and expect "nothing planned".
- **Actual:** The card sent `appliances: []`; the server had earlier been taught to treat `[]` as "no override, use the stored list" because the small model powering the host sends `[]` when it means "all". Both are reasonable; together they made untick-all silently replan everything, with the checkboxes still showing unticked.
- **Severity:** Major (the one interaction the card exists for gave a wrong answer, and nothing looked broken).
- **Fix:** An explicit `exact: true` flag on `plan_day` / `arm_plan`. The card sets it; models never do. Both semantics are tested side by side.
- **Lesson worth logging for MCP App authors:** when a tool is called by a model *and* by a UI, an empty argument no longer has one meaning. Give the UI its own way to say "literally this".

## 2026-09-26 — `USER node` plus `VOLUME /data` gives you a volume the process cannot write
- **Task:** Run the image with a named volume for the JSON store.
- **Actual:** Docker creates a volume's mount point as root when the image does not already contain the directory. The process runs as `node`, so the first write fails and `/healthz` reports 503 — after the container has started "successfully".
- **Severity:** Major for anyone following the README's compose path; easy to miss because `docker run` without a volume works.
- **Fix:** `RUN mkdir -p /data && chown node:node /data` before `VOLUME`.
- **Suggestion:** none for Amazon; noted because every "run it in a container" judging path would have hit it.

## 2026-09-26 — Browser hosts need the CORS preflight answered *before* bearer auth
- **Task:** Connect a browser-based MCP Apps host to a token-protected endpoint from a different origin.
- **Actual:** The browser's `OPTIONS` preflight carries no `Authorization` header by design, so an endpoint that checks auth first returns 401 to the preflight and the real request is never sent. `Mcp-Session-Id` must also be listed in `Access-Control-Expose-Headers` or the client can never read the session it was issued.
- **Severity:** Major for browser hosts, invisible from `curl` or a desktop client.
- **Fix:** Preflight handled before auth (204 for allowed origins, 403 otherwise); session and protocol headers exposed; error responses (401/404) also carry CORS headers so the browser can read them. Covered by a test that boots the real process.
- **Suggestion for the MCP docs:** the Streamable HTTP security section covers Origin validation but not the preflight/expose-headers pair that a browser host actually needs; one paragraph would save every self-hosted server author the same hour.

## 2026-09-26 — Second sweep: the failures that only show up when something upstream is slow
- **Task:** Ask "what happens if VRM, Growatt or Bedrock simply never answers?"
- **Actual:** Nothing had a timeout. A hung inverter API would hang `assess()`, which hangs every tool call, which leaves the planner card frozen on "Re-planning…" with every control disabled — indistinguishable from a crash. A 30-minute idle reaper would also have closed a session that armed a plan at 09:00 and then went quiet, so the 15:00 reminder had nowhere to go.
- **Severity:** Major (silent, and exactly what a flaky home connection produces).
- **Fix:** `AbortSignal.timeout` on every upstream fetch and on the Bedrock call (plain-facts fallback); provider forecasts are accepted only as full, finite 24-hour series; the session TTL default is 6 h because an idle session costs one timer, not API calls. Cards now also follow the host's own theme via the MCP Apps host context instead of only the OS setting, and `log_grid_event` records telemetry time and only state changes, so it cannot teach the pattern the same outage twice.
- **Lesson:** every await on something outside the process needs a deadline, and every background feature needs an answer to "what keeps this alive while the user is silent?"

## 2026-09-30 — Third sweep: property tests, a front door, and the abuse cases
- **Task:** Stop reviewing the engine by reading it and instead let 1,500 random households try to break it.
- **Actual:** The invariants held (SOC in [0,100], adding load never raises SOC, plans never exceed the inverter, a plan never breaches a reserve the baseline kept) — but writing them surfaced two things reading had missed: `can_i_run` searched one hour fewer than `plan_day` for a slot, and an appliance too large for the inverter was reported as "no slot keeps the battery above reserve", which blames the wrong component. The simulator also hard-coded Lagos time instead of `TZ_OFFSET`, and a non-numeric `SIM_SPEED` would have produced a NaN clock.
- **Also fixed:** an open (token-less) endpoint had no ceiling on sessions or request size; a browser opening the server's address got a 404 instead of a page that says what this is; the dashboard printed the battery draw with a minus sign and squeezed its verdict on narrow hosts.
- **Severity:** Minor individually; the point is method. Property tests on a pure engine cost thirty lines and now run on every `npm test`.
- **Lesson for MCP server authors:** an MCP endpoint is also a URL people will paste into a browser. Answer `/` with something human; it is the cheapest onboarding you will ever ship.

## 2026-10-06 — The alert channel is deprecated under my feet
- **Task:** Confirm the server-push channel (`notifications/message` via the logging capability) is the right one for Alexa+ alerts.
- **Actual:** The SDK docs now mark MCP logging **deprecated as of protocol 2026-07-28 (SEP-2577)**, functional for at least twelve months. On a 2025-11-25 session — the hackathon's stated minimum — there is no other channel for a notification the client did not request; the 2026-07-28 replacement (`subscriptions/listen`) does not exist on the older era.
- **Severity:** Minor today (it works, and will through the window), Major for anyone designing a server-push feature this quarter without reading the deprecation note.
- **Workaround:** Keep logging notifications on 2025-era sessions; the alert payload is already a structured `{kind, text, …}` object, so moving it to a subscription stream later is a transport change, not a feature change. Documented in README.
- **Suggestion:** The Streamable HTTP docs should name the recommended channel for unsolicited server alerts on each protocol era, and the hackathon rules should say whether 2026-07-28 servers are accepted.

## 2026-10-08 — Elicitation: three surprises in one hour
- **Task:** Ask the user before `arm_plan` replaces a plan they already committed to, using MCP elicitation.
- **Actual:** (1) `server.server.elicitInput()` is marked deprecated and throws on a 2026-07-28-era connection — it only works on 2025-era sessions, which is what Alexa+'s minimum spec gives, so it is the right call here but will need `inputRequired(...)` later. (2) In the client SDK, spec methods are registered as `setRequestHandler("elicitation/create", handler)` while custom methods take a schema pair; passing the exported `ElicitRequestSchema` as the second argument fails with `'[object Object]' is not a spec request method`, and the handler receives the whole request, not `params`. (3) A handler error on the client surfaces on the server as `Cannot read properties of undefined (reading '~standard')` — a message that points at schemas, not at the real cause.
- **Severity:** Minor each, Major together for a first-time user of the feature; the docs show the server side but not a working test client.
- **Workaround:** Capability check first (`getClientCapabilities()?.elicitation`), try/catch around the ask, proceed when the host cannot answer; the card's path (`exact: true`) never asks because it has its own Re-arm control.
- **Suggestion:** One end-to-end example in the SDK docs — server asks, in-memory test client answers — would have made this ten minutes.

## 2026-10-08 — Building a host: the SDK carries you, the browser gets in the way
- **Task:** A simulated Alexa+ host page: real MCP client, cards in iframes, pushed notifications, voice.
- **Actual:** The MCP Apps `AppBridge` did the hard part (card lifecycle, size changes, forwarding the card's `tools/call` to my client). What cost time was around it: (1) a card loaded directly in a tab (no host) rejects `connect()` with "Method not found" — correct, but the message should say "no host"; (2) `fallbackNotificationHandler` is the only way to catch `notifications/message` on the client without registering a schema per method, and it is easy to miss in the docs; (3) spec-method client handlers (`elicitation/create`) take `(method, handler)` while custom methods take a schema pair, and the typed overloads lag the runtime, so the registration needs a `@ts-expect-error`; (4) Web Speech recognition is Chrome-only and needs a user gesture, which is fine for a demo and worth saying in the UI.
- **Severity:** Minor each; the host was working end to end (cards, re-plan from a card, elicitation dialog, reminder toasts) in an afternoon and is checked in headless Chromium on every push.
- **Suggestion:** An ext-apps "minimal host" example — one page, one `Client`, one `AppBridge` — would make the host side as approachable as the view side already is.

## 2026-10-08 — OAuth 2.1 account linking: the SDK client is excellent, the spec text leaves gaps
- **Task:** Make Powerline linkable the way Alexa+ links accounts: protected-resource discovery, dynamic registration, consent, PKCE, refresh — and prove it with the official MCP client.
- **Actual:** The client side (`OAuthClientProvider` + `transport.finishAuth(code)`) worked first time against my server and needed no reading beyond the interface. On the server side the MCP authorization spec points at RFC 6749 / 7591 / 7636 / 8707 / 9728 but does not say which of their optional behaviours a host actually relies on: whether the `resource` parameter is sent (the SDK client sends it; I initially ignored it), whether a missing `code_challenge_method` means S256 or `plain` (RFC says plain; the SDK sends S256 explicitly), and whether invalid requests with a *valid* redirect should bounce to the client or render a page (RFC says bounce; I rendered a page first, which would have left an automated host waiting on its callback forever). A second-pass review found all three.
- **Severity:** Major for a first OAuth implementation — each is a silent integration failure, not an error.
- **Workaround:** Implemented the strict reading of each RFC and wrote the negative cases into `test/oauth.test.ts` (error redirects with `state`, `resource` audience check, `client_id` required on refresh, `error="invalid_token"` on expired tokens).
- **Suggestion:** A one-page "what an MCP host actually sends" table in the authorization spec — parameters, methods, headers — with a conformance test an authorization server can run against the official client.

## 2026-10-10 — AWS App Runner is closed to new customers; the deploy path had to change
- **Task:** Give judges a live HTTPS URL. The plan was App Runner from the GitHub repo (`apprunner.yaml`, one CLI call).
- **Actual:** The App Runner console greets a new account with "Starting April 30, 2026, AWS App Runner is no longer accepting new customers" and points at Amazon ECS Express Mode. Nothing in the service's own getting-started docs, the CLI, or the hackathon resources said so; the first sign was the banner after the GitHub-connection step had already been written up. Express Mode works and is one call too (`create-express-gateway-service`), but it needs a registry image rather than building from source, two IAM roles, and a default VPC — so a "deploy from GitHub with nothing installed" story became "CI publishes the image to GitHub's registry, CloudShell runs one script".
- **Severity:** Major for a weekend builder — an afternoon lost to rewriting a working deploy path; nothing in the product itself.
- **Workaround:** `.github/workflows/image.yml` publishes `ghcr.io/<owner>/powerline` on every push; `scripts/deploy-ecs-express.sh` creates the roles, the service, and prints the URL. App Runner files removed.
- **Suggestion:** Put the App Runner notice on the service's documentation landing page and in the AWS Builder Center hackathon resources, and give Express Mode a "from a public GitHub image" example in its getting-started page — that is the shape most hackathon projects have.
