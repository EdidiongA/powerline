/**
 * Simulated Alexa+ host — a complete MCP Apps host in one page.
 *
 *  - A real MCP client (Streamable HTTP) to this server's /mcp: tools, resources, prompts,
 *    and the GET notification stream, so alerts and reminders arrive here unprompted.
 *  - Cards rendered through the SDK's AppBridge in sandboxed iframes; card→server calls
 *    (the planner's re-plan, the report's tabs) go through the same client.
 *  - The language-model step runs server-side (/demo/llm) with Amazon Bedrock when configured,
 *    or a deterministic rule router otherwise — the page shows which.
 *  - Voice in (Web Speech API) and voice out (speechSynthesis), both optional.
 *
 * It is a stand-in for Alexa+, and says so in its header.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

type Tool = { name: string; description?: string; inputSchema: { type: "object"; [k: string]: unknown }; _meta?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean; _meta?: Record<string, unknown> };
type Block = { text?: string } | { toolUse?: { toolUseId: string; name: string; input: unknown } } | { toolResult?: { toolUseId: string; content: Array<{ text: string }>; status?: "success" | "error" } };
type Message = { role: "user" | "assistant"; content: Block[] };
type LlmReply = { mode: "bedrock" | "rules"; text: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>; stop: string };

const VERSION = typeof __POWERLINE_VERSION__ === "string" ? __POWERLINE_VERSION__ : "dev";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const thread = $<HTMLDivElement>("thread"), input = $<HTMLInputElement>("input"), send = $<HTMLButtonElement>("send"), mic = $<HTMLButtonElement>("mic");
const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
const conn = $<HTMLSpanElement>("conn"), brain = $<HTMLSpanElement>("brain"), voiceBtn = $<HTMLButtonElement>("voice");
const esc = (s: string) => s.replace(/[<&>"']/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

let client: Client | null = null;
const ALERTS_URI = "powerline://alerts";
let tools: Tool[] = [];
let token = sessionStorage.getItem("powerline.token") ?? "";
const history: Message[] = [];
let busy = false;
let speak = false;
const HINTS = ["How's the power?", "Set up my solar: 4.5 kW array, 10 kWh battery, 5 kW inverter, 20% reserve", "Remember the iron uses 2000 watts for 30 minutes", "Can I run the iron for 30 minutes?", "Plan my power for today", "Arm the plan", "How did we do this week?", "How long can we last if the grid goes?", "My meter is 1111 1111 1111 1, Ikeja Electric, 3 units left", "How are my units?", "Buy ₦5,000 of units", "Give me the evening briefing"];

// ---------- rendering ----------
function add(el: HTMLElement) { thread.appendChild(el); el.scrollIntoView({ block: "end", behavior: "smooth" }); return el; }
function you(text: string) { const d = document.createElement("div"); d.className = "msg you"; d.textContent = text; add(d); }
function alexa(text: string, toolNote?: string) {
  const d = document.createElement("div"); d.className = "msg alexa";
  // A prepaid token must read as one unbroken 20-digit code, never wrap mid-token.
  const body = esc(text).replace(/\b\d{4}(?:-\d{4}){4}\b/g, (t) => `<span class="nowrap">${t}</span>`);
  d.innerHTML = `<div class="who">Assistant · Powerline</div><div>${body}</div>${toolNote ? `<div class="tool">${toolNote}</div>` : ""}`;
  add(d); if (speak) say(text);
}
function toast(kind: string, text: string, sub?: string) {
  const d = document.createElement("div"); d.className = `toast ${esc(kind)}`;
  // A pushed reminder is the headline moment; assistive tech must hear it too.
  d.setAttribute("role", "status"); d.setAttribute("aria-live", kind === "critical" || kind === "alarm" ? "assertive" : "polite");
  d.innerHTML = `${esc(text).replace(/\b\d{4}(?:-\d{4}){4}\b/g, (t) => `<span class="nowrap">${t}</span>`)}<small>${esc(sub ?? `pushed by Powerline · ${kind}`)}</small>`;
  add(d); if (speak) say(text);
}
let thinking: HTMLElement | null = null;
function setBusy(on: boolean, label = "Thinking…") {
  busy = on; send.disabled = on; mic.disabled = on || !SR; input.disabled = on;
  if (on) { thinking = add(Object.assign(document.createElement("div"), { className: "thinking", textContent: label })); thinking.setAttribute("role", "status"); }
  else { thinking?.remove(); thinking = null; input.focus(); }
}

// ---------- cards (MCP Apps host side) ----------
const resourceCache = new Map<string, string>();
async function readUi(uri: string): Promise<string> {
  const hit = resourceCache.get(uri); if (hit) return hit;
  const res = await client!.readResource({ uri });
  const html = (res.contents[0] as { text?: string }).text ?? "";
  resourceCache.set(uri, html); return html;
}
async function renderCard(tool: Tool, args: Record<string, unknown>, result: ToolResult) {
  const uri = getToolUiResourceUri(tool); if (!uri) return;
  const html = await readUi(uri);
  const wrap = document.createElement("div"); wrap.className = "card";
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.title = `${tool.name} card`;
  wrap.appendChild(iframe); add(wrap);
  // The bridge is NOT bound to the current Client: a card must keep working after the session is reaped or the
  // server is redeployed, so its tool calls go through callTool(), which re-initialises on a 404 like the chat does.
  const bridge = new AppBridge(null, { name: "powerline-demo-host", version: VERSION }, { serverTools: {}, logging: {} }, { hostContext: hostContext() });
  bridge.oncalltool = async (p) => (await callTool(p.name, (p.arguments ?? {}) as Record<string, unknown>)) as never;
  bridge.addEventListener("sizechange", ({ height }) => { if (typeof height === "number" && height > 40) iframe.style.height = `${Math.min(900, Math.ceil(height))}px`; });
  bridge.oninitialized = () => { void bridge.sendToolInput({ arguments: args }); void bridge.sendToolResult(result as never); };
  bridge.onloggingmessage = ({ data }) => console.log("[card]", data);
  // srcdoc so the card has no origin to leak; the bridge talks over postMessage only.
  iframe.srcdoc = html;
  iframe.addEventListener("load", () => { try { bridge.setHostContext(hostContext()); } catch { /* not yet connected: the constructor value stands */ } void bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)).catch((e) => console.warn("card bridge", e)); }, { once: true });
  liveCards.push({ bridge, wrap });
  while (liveCards.length > 20) { // keep the page light: the oldest card goes static, and says so
    const old = liveCards.shift()!;
    void old.bridge.close().catch(() => {});
    const note = document.createElement("div"); note.className = "stale"; note.textContent = "This card is no longer live — ask again for a fresh one.";
    old.wrap.appendChild(note); old.wrap.classList.add("static");
  }
}
const liveCards: Array<{ bridge: AppBridge; wrap: HTMLDivElement }> = [];
const currentTheme = (): "light" | "dark" => (document.documentElement.dataset.theme as "light" | "dark" | undefined) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const hostContext = () => ({ theme: currentTheme(), displayMode: "inline" as const, availableDisplayModes: ["inline" as const] });

// ---------- the conversation loop ----------
async function llm(messages: Message[]): Promise<LlmReply> {
  const res = await fetch("/demo/llm", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ messages, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  let r: Partial<LlmReply>;
  try { r = (await res.json()) as Partial<LlmReply>; } catch { throw new Error("the model endpoint returned something that was not JSON"); }
  if (!r || typeof r !== "object") throw new Error("the model endpoint returned an unexpected response");
  // Never trust the shape: a proxy page or a half reply must degrade to "no answer", not a TypeError on screen.
  const toolCalls = (Array.isArray(r.toolCalls) ? r.toolCalls : []).filter((c) => c && typeof c.name === "string" && typeof c.id === "string").map((c) => ({ ...c, input: c.input && typeof c.input === "object" ? c.input : {} }));
  return { mode: r.mode === "bedrock" ? "bedrock" : "rules", text: typeof r.text === "string" ? r.text : "", toolCalls, stop: typeof r.stop === "string" ? r.stop : "" };
}
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();

/** Keep the conversation bounded without orphaning a toolResult from its toolUse: drop whole turns from the front. */
const historyChars = () => history.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
function trimHistory() {
  // Bounded by count AND by size (the server refuses >60k chars); always drop whole turns from the front.
  while (history.length > 1 && (history.length > 24 || historyChars() > 48_000)) {
    history.shift();
    while (history.length && !(history[0].role === "user" && history[0].content.some((c) => "text" in c))) history.shift();
  }
}
/** A reaped or restarted session answers 404; the SDK client does not re-initialise by itself. */
const sessionGone = (e: unknown) => /404|-32001|Session not found|not connected|Not connected/i.test((e as Error)?.message ?? "");
async function reconnect(): Promise<boolean> {
  client = null; conn.textContent = "reconnecting…"; conn.className = "pill";
  await connect(true);
  return !!client;
}
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!client && !(await reconnect())) throw new Error("not connected"); // a card click after the stream dropped recovers like the chat does
  // Long enough to cover a question the server asks mid-call (buy_units waits up to 120 s for the person's answer).
  const opts = { timeout: 150_000 };
  try { return (await client!.callTool({ name, arguments: args }, opts)) as ToolResult; }
  catch (e) {
    if (!sessionGone(e) || !(await reconnect())) throw e;
    return (await client!.callTool({ name, arguments: args }, opts)) as ToolResult; // once more on the fresh session
  }
}

async function turn(userText: string) {
  if (busy) return;
  if (!client && !(await reconnect())) { you(userText); alexa(conn.textContent === "token required" ? "This server needs a token — click the red pill in the header to enter it." : "Not connected to Powerline yet — check the server and reload."); return; }
  you(userText);
  trimHistory(); // trim first so `mark` points at a real position after the shift
  const mark = history.length; // on any failure the turn is rolled back, so roles keep alternating for Bedrock
  history.push({ role: "user", content: [{ text: userText.slice(0, 2_000) }] });
  setBusy(true);
  const used: string[] = [];
  try {
    for (let hop = 0; hop < 6; hop++) {
      const reply = await llm(history);
      brain.textContent = reply.mode === "bedrock" ? "Bedrock" : "phrase router (offline)";
      const assistant: Message = { role: "assistant", content: [] };
      if (reply.text) assistant.content.push({ text: reply.text });
      for (const c of reply.toolCalls) assistant.content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.input } });
      if (assistant.content.length) history.push(assistant);
      if (reply.toolCalls.length === 0) {
        if (reply.text) alexa(reply.text, used.length ? `via ${used.map((u) => `<code>${esc(u)}</code>`).join(", ")}` : undefined);
        else { history.length = Math.min(mark, history.length); alexa("I didn't get a reply that time — ask again?"); }
        break;
      }
      // A model may think aloud before calling a tool ("Let me check the battery…"); show it.
      if (reply.mode === "bedrock" && reply.text) alexa(reply.text);
      // Execute the calls through the MCP session; cards render from the results.
      const results: Block[] = [];
      for (const c of reply.toolCalls) {
        const tool = tools.find((t) => t.name === c.name);
        let r: ToolResult;
        try { r = await callTool(c.name, c.input); }
        catch (e) { r = { content: [{ type: "text", text: `Tool ${c.name} failed: ${(e as Error).message}` }], isError: true }; }
        const text = textOf(r) || (r.isError ? "The tool returned an error." : "Done.");
        used.push(c.name);
        if (reply.mode === "rules" && reply.text && c === reply.toolCalls[0]) alexa(reply.text); // the lead-in once, not once per call
        if (tool && getToolUiResourceUri(tool) && !r.isError) { try { await renderCard(tool, c.input, r); } catch (e) { console.warn("card failed", e); } }
        if (reply.mode === "rules") alexa(text, `<code>${esc(c.name)}</code>${r._meta && (r._meta as { bedrock?: boolean }).bedrock === false && c.name === "evening_briefing" ? " · plain facts (Bedrock not configured)" : ""}`);
        results.push({ toolResult: { toolUseId: c.id, content: [{ text: text.slice(0, 4000) }], status: r.isError ? "error" : "success" } });
      }
      history.push({ role: "user", content: results });
      if (reply.mode === "rules") break; // rules speak the tool text directly; no second model turn
      if (hop === 5) alexa("That took more steps than expected; ask again if something is missing.");
    }
  } catch (e) {
    history.length = Math.min(mark, history.length); // never leave a dangling user turn or an unanswered toolUse behind
    alexa(`Something went wrong: ${(e as Error).message}`);
  } finally { setBusy(false); }
}

// ---------- voice ----------
function say(text: string) {
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; speechSynthesis.speak(u); } catch { /* unsupported */ }
}
voiceBtn.onclick = () => { speak = !speak; voiceBtn.setAttribute("aria-pressed", String(speak)); if (!speak) try { speechSynthesis.cancel(); } catch { /* ignore */ } };
if (!SR) { mic.disabled = true; mic.title = "Speech recognition is not available in this browser"; }
else mic.onclick = () => {
  const rec = new SR(); rec.lang = "en-US"; rec.interimResults = false;
  mic.setAttribute("aria-pressed", "true");
  rec.onresult = (ev: SpeechRecognitionEvent) => { const t = ev.results[0]?.[0]?.transcript ?? ""; mic.setAttribute("aria-pressed", "false"); if (t) { input.value = ""; void turn(t); } };
  rec.onerror = () => { mic.setAttribute("aria-pressed", "false"); alexa("I didn't catch that."); };
  rec.onend = () => mic.setAttribute("aria-pressed", "false");
  try { rec.start(); } catch { mic.setAttribute("aria-pressed", "false"); }
};

// ---------- theme ----------
$<HTMLButtonElement>("theme").onclick = () => {
  const cur = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  // setHostContext keeps the bridge's own copy current (a card that re-reads getHostContext() later sees the new theme) and notifies the view.
  // Only connected bridges: setHostContext fires a notification whose rejection on a transport-less bridge is not catchable here;
  // a card still loading picks the theme up from hostContext() just before it connects.
  for (const { bridge } of liveCards) { try { if (bridge.transport) bridge.setHostContext(hostContext()); } catch { /* a closed bridge */ } }
};

// ---------- connection ----------
async function connect(quiet = false) {
  if (!quiet) { conn.textContent = "connecting…"; conn.className = "pill"; }
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", location.href), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);
  const c = new Client({ name: "powerline-demo-host", version: VERSION }, { capabilities: { elicitation: {} } });
  // Alerts arrive as updates to powerline://alerts once subscribed (the current MCP channel); a server that
  // cannot take subscriptions still reaches us through the logging push, which is handled too.
  let lastAlertId = 0;
  c.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/message") {
      const d = (n.params as { data?: { kind?: string; text?: string; id?: number } }).data;
      if (typeof d?.id === "number") { if (d.id <= lastAlertId) return; lastAlertId = d.id; } // same ids as the resource: never shown twice
      if (d?.text) toast(d.kind ?? "alert", d.text);
    }
    if (n.method === "notifications/resources/updated" && (n.params as { uri?: string }).uri === ALERTS_URI) {
      try {
        const res = await c.readResource({ uri: ALERTS_URI });
        const { alerts } = JSON.parse((res.contents[0] as { text?: string }).text ?? "{}") as { alerts?: Array<{ id: number; kind: string; text: string }> };
        for (const a of alerts ?? []) if (a.id > lastAlertId) { lastAlertId = a.id; toast(a.kind, a.text); }
      } catch (e) { console.warn("could not read alerts", e); }
    }
  };
  // Elicitation: Powerline asks before replacing an armed plan and before buying units. Every question it asks
  // is a yes/no with boolean fields, so "yes" sets each of them true; "no" (or Escape) declines.
  c.setRequestHandler("elicitation/create", async (req: { params?: { message?: string; requestedSchema?: { properties?: Record<string, { type?: string }> } } }, ctx?: { mcpReq?: { signal?: AbortSignal } }) => {
    const ok = await ask(req.params?.message ?? "Powerline is asking for confirmation.", ctx?.mcpReq?.signal);
    const props = req.params?.requestedSchema?.properties ?? {};
    const content = Object.fromEntries(Object.entries(props).filter(([, v]) => v?.type === "boolean").map(([k]) => [k, true]));
    return ok ? { action: "accept", content } : { action: "decline" };
  });
  let listed: Tool[];
  try {
    await c.connect(transport);
    listed = (await c.listTools()).tools as Tool[]; // inside the try: a server that drops between the two must not leave an unhandled rejection and a stuck pill
  } catch (e) {
    const msg = (e as Error).message;
    if (/401|Unauthorized/.test(msg)) { conn.textContent = "token required"; conn.className = "pill bad"; askToken(token ? "That token was not accepted — check it and try again." : undefined); return; }
    conn.textContent = "not connected"; conn.className = "pill bad";
    if (!quiet) alexa(`Could not connect to Powerline at ${location.origin}/mcp: ${msg}`);
    return;
  }
  client = c; tools = listed;
  if (c.getServerCapabilities()?.resources?.subscribe) await c.subscribeResource({ uri: ALERTS_URI }).catch((e) => console.warn("alerts subscription failed; falling back to logging", e));
  c.onclose = () => { if (client === c) { client = null; conn.textContent = "disconnected — reconnecting on next message"; conn.className = "pill bad"; } };
  conn.textContent = `connected · ${tools.length} tools`; conn.className = "pill ok";
  if (quiet) return;
  const health = await fetch("/healthz").then((r) => r.json()).catch(() => null) as { telemetry?: string; store?: { backend?: string }; llm?: boolean } | null;
  brain.textContent = health?.llm ? "Bedrock" : "phrase router (offline)";
  alexa(`Hi. I'm connected to Powerline${health?.telemetry ? ` (${health.telemetry})` : ""}. Ask me how the power is, whether you can run something, or to plan the day.`);
}
/**
 * A styled yes/no question (the elicitation dialog). Resolves false on No, Escape, a cancelled or timed-out request,
 * or a dialog the browser cannot show. Focus starts on No, and Yes ignores activation for the first half second, so a
 * stray Enter from the message box can never confirm a purchase.
 */
function ask(message: string, signal?: AbortSignal): Promise<boolean> {
  const dlg = $<HTMLDialogElement>("askDialog");
  if (typeof dlg?.showModal !== "function") return Promise.resolve(confirm(message));
  if (dlg.open) return Promise.resolve(false); // one question at a time (the open one closes itself on abort or expiry)
  if (signal?.aborted) return Promise.resolve(false);
  $<HTMLParagraphElement>("askText").textContent = message;
  const yes = $<HTMLButtonElement>("askYes");
  yes.disabled = true;
  const arm = setTimeout(() => { yes.disabled = false; }, 500);
  // The server gives up after its own timeout; close well before it so a late "yes" is never sent to a dead request.
  const expire = setTimeout(() => { if (dlg.open) dlg.close("no"); }, 110_000);
  const onAbort = () => { if (dlg.open) dlg.close("no"); };
  signal?.addEventListener("abort", onAbort, { once: true });
  dlg.returnValue = "";
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => { clearTimeout(arm); clearTimeout(expire); signal?.removeEventListener("abort", onAbort); resolve(dlg.returnValue === "yes"); }, { once: true });
    dlg.showModal();
    $<HTMLButtonElement>("askNo").focus();
    if (speak) say(message);
  });
}
function askToken(problem?: string) {
  const dlg = $<HTMLDialogElement>("tokenDialog"), inp = $<HTMLInputElement>("tokenInput"), err = $<HTMLParagraphElement>("tokenError");
  err.textContent = problem ?? ""; err.hidden = !problem;
  // The dialog's form has method="dialog", so Enter and the button both close it with returnValue "ok"; Escape leaves it "".
  dlg.onclose = () => { if (dlg.returnValue !== "ok") return; token = inp.value.trim(); sessionStorage.setItem("powerline.token", token); void connect(); };
  dlg.returnValue = ""; // persists across opens: without this, Escape after one submit would re-submit the rejected token forever
  if (!dlg.open) dlg.showModal();
  inp.focus();
}
conn.onclick = () => { if (conn.textContent === "token required") askToken(); };

// ---------- wiring ----------
$<HTMLFormElement>("form").onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ""; void turn(t); };
const hints = $<HTMLDivElement>("hints");
// ?clean (for filming and screenshots): no hint chips under the message box.
if (new URLSearchParams(location.search).has("clean")) hints.hidden = true;
for (const h of HINTS) { const b = document.createElement("button"); b.type = "button"; b.textContent = h; b.onclick = () => void turn(h); hints.appendChild(b); }
void connect();
