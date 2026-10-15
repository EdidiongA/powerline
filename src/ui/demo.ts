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

type Tool = { name: string; description?: string; inputSchema: unknown; _meta?: Record<string, unknown> };
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
let tools: Tool[] = [];
let token = sessionStorage.getItem("powerline.token") ?? "";
const history: Message[] = [];
let busy = false;
let speak = false;
const HINTS = ["How's the power?", "Set up my solar: 4.5 kW array, 10 kWh battery, 5 kW inverter, 20% reserve", "Remember the iron uses 2000 watts for 30 minutes", "Can I run the iron for 30 minutes?", "Plan my power for today", "Arm the plan", "How did we do this week?", "How long can we last if the grid goes?", "Give me the evening briefing"];

// ---------- rendering ----------
function add(el: HTMLElement) { thread.appendChild(el); el.scrollIntoView({ block: "end", behavior: "smooth" }); return el; }
function you(text: string) { const d = document.createElement("div"); d.className = "msg you"; d.textContent = text; add(d); }
function alexa(text: string, toolNote?: string) {
  const d = document.createElement("div"); d.className = "msg alexa";
  d.innerHTML = `<div class="who">Alexa+ · Powerline</div><div>${esc(text)}</div>${toolNote ? `<div class="tool">${toolNote}</div>` : ""}`;
  add(d); if (speak) say(text);
}
function toast(kind: string, text: string, sub?: string) {
  const d = document.createElement("div"); d.className = `toast ${esc(kind)}`;
  d.innerHTML = `${esc(text)}<small>${esc(sub ?? `pushed by Powerline · ${kind}`)}</small>`;
  add(d); if (speak) say(text);
}
let thinking: HTMLElement | null = null;
function setBusy(on: boolean, label = "Thinking…") {
  busy = on; send.disabled = on; mic.disabled = on || !SR; input.disabled = on;
  if (on) { thinking = add(Object.assign(document.createElement("div"), { className: "thinking", textContent: label })); }
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
  const theme = (document.documentElement.dataset.theme as "light" | "dark" | undefined) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const bridge = new AppBridge(client!, { name: "powerline-demo-host", version: VERSION }, { serverTools: {}, logging: {} }, { hostContext: { theme, displayMode: "inline", availableDisplayModes: ["inline"] } });
  bridge.addEventListener("sizechange", ({ height }) => { if (typeof height === "number" && height > 40) iframe.style.height = `${Math.min(900, Math.ceil(height))}px`; });
  bridge.oninitialized = () => { void bridge.sendToolInput({ arguments: args }); void bridge.sendToolResult(result as never); };
  bridge.onloggingmessage = ({ data }) => console.log("[card]", data);
  // srcdoc so the card has no origin to leak; the bridge talks over postMessage only.
  iframe.srcdoc = html;
  iframe.addEventListener("load", () => { void bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)); }, { once: true });
  themedBridges.push(bridge);
  while (themedBridges.length > 20) { // keep the page light: oldest cards go static
    const old = themedBridges.shift()!;
    void old.close().catch(() => {});
  }
}
const themedBridges: AppBridge[] = [];

// ---------- the conversation loop ----------
async function llm(messages: Message[]): Promise<LlmReply> {
  const res = await fetch("/demo/llm", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ messages, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as LlmReply;
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
  if (!client) throw new Error("not connected");
  try { return (await client.callTool({ name, arguments: args })) as ToolResult; }
  catch (e) {
    if (!sessionGone(e) || !(await reconnect())) throw e;
    return (await client!.callTool({ name, arguments: args })) as ToolResult; // once more on the fresh session
  }
}

async function turn(userText: string) {
  if (busy) return;
  if (!client && !(await reconnect())) { you(userText); alexa("Not connected to Powerline yet — check the server and reload."); return; }
  you(userText);
  trimHistory(); // trim first so `mark` points at a real position after the shift
  const mark = history.length; // on any failure the turn is rolled back, so roles keep alternating for Bedrock
  history.push({ role: "user", content: [{ text: userText.slice(0, 2_000) }] });
  setBusy(true);
  const used: string[] = [];
  try {
    for (let hop = 0; hop < 6; hop++) {
      const reply = await llm(history);
      brain.textContent = reply.mode === "bedrock" ? "Bedrock" : "rules (no Bedrock)";
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
  rec.onresult = (ev) => { const t = ev.results[0]?.[0]?.transcript ?? ""; mic.setAttribute("aria-pressed", "false"); if (t) { input.value = ""; void turn(t); } };
  rec.onerror = () => { mic.setAttribute("aria-pressed", "false"); alexa("I didn't catch that."); };
  rec.onend = () => mic.setAttribute("aria-pressed", "false");
  try { rec.start(); } catch { mic.setAttribute("aria-pressed", "false"); }
};

// ---------- theme ----------
$<HTMLButtonElement>("theme").onclick = () => {
  const cur = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  for (const b of themedBridges) void b.sendHostContextChanged({ theme: next }).catch(() => {});
};

// ---------- connection ----------
async function connect(quiet = false) {
  if (!quiet) { conn.textContent = "connecting…"; conn.className = "pill"; }
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", location.href), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);
  const c = new Client({ name: "powerline-demo-host", version: VERSION }, { capabilities: { elicitation: {} } });
  c.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/message") { const d = (n.params as { data?: { kind?: string; text?: string } }).data; if (d?.text) toast(d.kind ?? "alert", d.text); }
  };
  // Elicitation: Powerline asks before replacing an armed plan; answer with a plain confirm().
  // @ts-expect-error — spec-method registration takes (method, handler)
  c.setRequestHandler("elicitation/create", async (req: { params?: { message?: string } }) => {
    const ok = confirm(req.params?.message ?? "Powerline is asking for confirmation.");
    return { action: ok ? "accept" : "decline", content: ok ? { replace: true } : undefined };
  });
  try {
    await c.connect(transport);
  } catch (e) {
    const msg = (e as Error).message;
    if (/401|Unauthorized/.test(msg)) { conn.textContent = "token required"; conn.className = "pill bad"; askToken(); return; }
    conn.textContent = "not connected"; conn.className = "pill bad";
    alexa(`Could not connect to Powerline at ${location.origin}/mcp: ${msg}`);
    return;
  }
  client = c;
  c.onclose = () => { if (client === c) { client = null; conn.textContent = "disconnected — reconnecting on next message"; conn.className = "pill bad"; } };
  tools = (await c.listTools()).tools as Tool[];
  conn.textContent = `connected · ${tools.length} tools`; conn.className = "pill ok";
  if (quiet) return;
  const health = await fetch("/healthz").then((r) => r.json()).catch(() => null) as { telemetry?: string; store?: { backend?: string }; llm?: boolean } | null;
  brain.textContent = health?.llm ? "Bedrock" : "rules (no Bedrock)";
  alexa(`Hi. I'm connected to Powerline${health?.telemetry ? ` (${health.telemetry})` : ""}. Ask me how the power is, whether you can run something, or to plan the day.`);
}
function askToken() {
  const dlg = $<HTMLDialogElement>("tokenDialog"), inp = $<HTMLInputElement>("tokenInput");
  $<HTMLButtonElement>("tokenOk").onclick = () => { token = inp.value.trim(); sessionStorage.setItem("powerline.token", token); dlg.close(); void connect(); };
  dlg.showModal();
}

// ---------- wiring ----------
$<HTMLFormElement>("form").onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ""; void turn(t); };
const hints = $<HTMLDivElement>("hints");
for (const h of HINTS) { const b = document.createElement("button"); b.type = "button"; b.textContent = h; b.onclick = () => void turn(h); hints.appendChild(b); }
void connect();
