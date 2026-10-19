/**
 * The language-model step for the simulated Alexa+ host.
 *
 * The browser owns the conversation and the MCP session; it asks this endpoint only for
 * "what would the assistant say or call next". With Amazon Bedrock configured the answer
 * comes from the Converse API with the server's tools offered as Bedrock tools; without it,
 * a deterministic router maps phrasings to tool calls so the demo still works offline.
 * Credentials never reach the browser; the browser never talks to Bedrock.
 */
import { routeByRules, type RuleTurn } from "./router.js";

export interface ToolSpec { name: string; description?: string; inputSchema: unknown }
export interface ToolCall { id: string; name: string; input: Record<string, unknown> }
/** Conversation in Bedrock Converse shape, kept by the browser between turns. */
export interface Message { role: "user" | "assistant"; content: Array<{ text?: string } | { toolUse?: { toolUseId: string; name: string; input: unknown } } | { toolResult?: { toolUseId: string; content: Array<{ text: string }>; status?: "success" | "error" } }> }
export interface LlmReply { mode: "bedrock" | "rules"; text: string; toolCalls: ToolCall[]; stop: string }

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const TIMEOUT_MS = (() => { const n = Number(process.env.BEDROCK_TIMEOUT_MS); return process.env.BEDROCK_TIMEOUT_MS?.trim() && Number.isFinite(n) && n > 0 ? n : 20_000; })();
const MAX_MESSAGES = 40;
const MAX_CHARS = 60_000;

export const SYSTEM_PROMPT = [
  "You are the voice assistant of a simulated Alexa+ host, speaking for Powerline, a home power copilot for a household with a solar array, a battery and an unreliable grid.",
  "Answer in one to three short spoken sentences. Never invent a number: every figure comes from a tool result. If a tool errors, say what failed in plain words.",
  "Call power_status before giving advice about the battery. For 'can I run X', call can_i_run. For planning, call plan_day, then offer to arm reminders; on yes call arm_plan.",
  "For reports (how did we do, what did the grid cost) call energy_report; for 'how long can we last if the grid goes' call outage_outlook; for a briefing or outlook call evening_briefing.",
  "When a tool renders a card (dashboard, planner, report), do not repeat every number on it — say the one thing that matters and point at the card.",
  "If the household has not been set up (profileIsDefault is true), give the answer and add once: say 'set up my solar' to use your own system.",
  "When the person reports the grid going off or coming back ('NEPA took light', 'we just got light'), call log_grid_event first; if it went off, also call outage_outlook. 'Switch off X' is not something you can do — say so in one sentence and offer can_i_run or plan_day instead.",
  "People speak loosely. Map what they mean to the tools: 'what does tomorrow morning look like', 'will we last the night' → evening_briefing; 'when should I do the laundry' → plan_day; 'give me everything', 'full rundown' → call power_status, plan_day, outage_outlook and energy_report together, never arm_plan unless asked. 'Do all of them' / 'all of those' refers to options YOU just listed when your previous message listed any (example appliances to add, say) — act on those; only when nothing was listed does it mean the full picture.",
  "add_appliance works WITHOUT watts or minutes for common appliances (iron, kettle, fridge, freezer, pump, washing machine, microwave, AC, fan, TV, laptop, lights…): Powerline fills in a preset and says what it assumed. So when the person names appliances with no numbers, add them at once — one add_appliance call per appliance — and then plan_day; never ask for wattages first. If they say 'all of them' about a list you just offered, add every item on that list.",
  "Prepaid electricity: 'how are my units', 'will my units last', 'do I need to buy light' → prepaid_units. 'My meter is …, Ikeja Electric' or 'the meter shows 40 units' → set_meter. 'Buy/top up N naira of units', 'buy light' → buy_units with the amount (omit it for the suggested top-up); Powerline asks the person to confirm on its own, so never call buy_units unless they asked to buy, and never pass a quoteId unless they have just said yes to that quote. Read the token out in groups of four.",
  "If a request is outside home power, say so in one sentence and offer the closest thing you can do. Never answer a request by only listing what you can do.",
].join(" ");

export const llmEnabled = Boolean(MODEL_ID);

/** A tiny semaphore: Bedrock's per-model rate is shared by every visitor, so bursts queue here instead of failing there. */
const MAX_IN_FLIGHT = 3;
let inFlight = 0; const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; waiters.shift()?.(); }
}

type Sender = (input: Record<string, unknown>) => Promise<{ output?: { message?: { content?: Array<Record<string, unknown>> } }; stopReason?: string }>;
let send: Sender | null = null;
/** Test seam: replace the Bedrock call with a fake so the mapping on both sides can be checked without AWS. */
export function _setBedrockSenderForTests(fn: Sender | null, enabled?: boolean): void { send = fn; forcedEnabled = enabled; }
let forcedEnabled: boolean | undefined;
const enabled = () => forcedEnabled ?? llmEnabled;

/** Validate and bound what the browser sent; the shape is trusted only after this. */
export function checkMessages(raw: unknown): Message[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "messages must be a non-empty array";
  if (raw.length > MAX_MESSAGES) return `at most ${MAX_MESSAGES} messages per turn`;
  if (JSON.stringify(raw).length > MAX_CHARS) return "conversation too large";
  for (const m of raw as Message[]) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.content) || m.content.length === 0) return "each message needs a role and content";
    for (const c of m.content) {
      if (!c || typeof c !== "object") return "each content block must be an object";
      const b = c as { text?: unknown; toolUse?: unknown; toolResult?: { content?: unknown } };
      if (typeof b.text === "string" && b.text.length > 4_000) return "a single message is too long (4,000 characters)";
      if (b.toolResult !== undefined && (!b.toolResult || typeof b.toolResult !== "object" || !Array.isArray(b.toolResult.content) || !b.toolResult.content.every((x) => x && typeof x === "object"))) return "a toolResult needs a content array";
      if (b.toolUse !== undefined && (!b.toolUse || typeof b.toolUse !== "object")) return "a toolUse must be an object";
    }
  }
  return raw as Message[];
}

/**
 * Bedrock Converse insists on strictly alternating roles and on every toolUse being answered by a
 * toolResult in the very next message. A browser that lost a hop (429, timeout, reload) can send a
 * history that breaks either rule; repair it here so one bad turn never poisons the conversation.
 */
export function repairHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) { prev.content = [...prev.content, ...m.content]; continue; } // merge same-role neighbours
    out.push({ role: m.role, content: [...m.content] });
  }
  // A trailing assistant toolUse with no result cannot be continued; drop it.
  while (out.length && out[out.length - 1].role === "assistant" && out[out.length - 1].content.some((c) => "toolUse" in c)) out.pop();
  // A toolResult must answer the immediately preceding assistant toolUse; orphans are dropped.
  for (let i = 0; i < out.length; i++) {
    const hasResult = out[i].role === "user" && out[i].content.some((c) => "toolResult" in c);
    const answered = i > 0 && out[i - 1].role === "assistant" && out[i - 1].content.some((c) => "toolUse" in c);
    if (hasResult && !answered) out[i].content = out[i].content.filter((c) => !("toolResult" in c));
  }
  // Dropping orphans can leave two assistant turns adjacent; merge once more, and drop an assistant
  // toolUse set that is not fully answered by the next message.
  const kept: Message[] = [];
  for (const m of out.filter((x) => x.content.length > 0)) {
    const prev = kept[kept.length - 1];
    if (prev && prev.role === m.role) { prev.content = [...prev.content, ...m.content]; continue; }
    kept.push(m);
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].role !== "assistant") continue;
    const uses = kept[i].content.filter((c) => "toolUse" in c).map((c) => (c as { toolUse: { toolUseId: string } }).toolUse.toolUseId);
    if (!uses.length) continue;
    const answered = new Set((kept[i + 1]?.content ?? []).filter((c) => "toolResult" in c).map((c) => (c as { toolResult: { toolUseId: string } }).toolResult.toolUseId));
    if (!uses.every((id) => answered.has(id))) { kept.splice(i, 1); if (kept[i]?.role === "user" && kept[i - 1]?.role === "user") { kept[i - 1].content = [...kept[i - 1].content, ...kept[i].content]; kept.splice(i, 1); } }
  }
  while (kept.length && kept[0].role !== "user") kept.shift(); // conversations start with the user
  return kept;
}

export function converseInput(messages: Message[], tools: ToolSpec[]): Record<string, unknown> {
  return {
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages: repairHistory(messages),
    // Bedrock requires an object schema; a tool with no inputs still gets {type:"object"}.
    ...(tools.length ? { toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: (t.description ?? t.name).slice(0, 1000), inputSchema: { json: isObjectSchema(t.inputSchema) ? t.inputSchema : { type: "object", properties: {} } } } })) } } : {}),
    inferenceConfig: { maxTokens: 400, temperature: 0.3 },
  };
}
const isObjectSchema = (s: unknown): s is Record<string, unknown> => !!s && typeof s === "object" && (s as { type?: unknown }).type === "object";

export async function nextTurn(messages: Message[], tools: ToolSpec[]): Promise<LlmReply> {
  if (!enabled()) return rulesTurn(messages, tools);
  if (!send) {
    const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({});
    send = (input) => client.send(new ConverseCommand(input as never), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) }) as never;
  }
  // Bedrock throttles bursts. Two things keep that away from the person: at most a few calls in
  // flight at once (the rest queue briefly), and up to two backed-off retries on a throttle.
  const res = await withSlot(async () => {
    const input = converseInput(messages, tools);
    let delay = 1_200;
    for (let attempt = 0; ; attempt++) {
      try { return await send!(input); }
      catch (e) {
        const name = (e as { name?: string }).name ?? "", msg = (e as Error).message ?? "";
        if (attempt >= 2 || !/Throttling|TooManyRequests|ServiceUnavailable|ModelNotReady/i.test(`${name} ${msg}`)) throw e;
        await new Promise((r) => setTimeout(r, delay + Math.random() * 800)); delay *= 2;
      }
    }
  });
  const blocks = res.output?.message?.content ?? [];
  const text = blocks.map((b) => (typeof b.text === "string" ? b.text : "")).filter(Boolean).join(" ").trim();
  const toolCalls: ToolCall[] = blocks.flatMap((b) => {
    const u = b.toolUse as { toolUseId?: string; name?: string; input?: unknown } | undefined;
    return u?.name && u.toolUseId ? [{ id: u.toolUseId, name: u.name, input: (u.input && typeof u.input === "object" ? u.input : {}) as Record<string, unknown> }] : [];
  });
  return { mode: "bedrock", text, toolCalls, stop: res.stopReason ?? "end_turn" };
}

/** Deterministic fallback: the last user utterance decides; tool results are read back verbatim. */
function rulesTurn(messages: Message[], tools: ToolSpec[]): LlmReply {
  const last = messages[messages.length - 1];
  const lastUserText = [...messages].reverse().find((m) => m.role === "user" && m.content.some((c) => "text" in c && c.text))?.content.map((c) => ("text" in c ? c.text ?? "" : "")).join(" ") ?? "";
  // After a tool result, speak it.
  const toolResults = last.role === "user" ? last.content.flatMap((c) => ("toolResult" in c && c.toolResult ? c.toolResult.content.map((x) => x.text) : [])) : [];
  if (toolResults.length) return { mode: "rules", text: toolResults.join(" "), toolCalls: [], stop: "end_turn" };
  const turn: RuleTurn = routeByRules(lastUserText, tools.map((t) => t.name));
  const calls = turn.tool ? [{ tool: turn.tool, input: turn.input }, ...(turn.also ?? [])] : [];
  const stamp = Date.now();
  return { mode: "rules", text: turn.text, toolCalls: calls.map((c, i) => ({ id: `rule-${stamp}-${i}`, name: c.tool, input: c.input })), stop: calls.length ? "tool_use" : "end_turn" };
}
