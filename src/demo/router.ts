/**
 * Rule-based intent router — the no-model fallback for the simulated host, and a readable
 * statement of the phrasings Powerline expects. Pure, so it is unit-tested in isolation.
 */
export interface RuleTurn { tool: string | null; input: Record<string, unknown>; text: string; also?: Array<{ tool: string; input: Record<string, unknown> }> }

const MENU = "I didn't catch that. Try “how's the power?”, “can I run the iron for 30 minutes?”, “plan my power for today”, “how did we do this week?”, “will the battery last till morning?” — or “give me everything” for the full picture.";

const num = (s: string, re: RegExp) => { const m = re.exec(s); return m ? Number(m[1]) : undefined; };
// Punctuation goes, decimals stay ("4.5 kw" must survive; a trailing "." must not).
const clean = (s: string) => s.toLowerCase().replace(/[?!,;:]/g, " ").replace(/\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();

export function routeByRules(utterance: string, available: string[]): RuleTurn {
  const u = clean(utterance);
  const has = (t: string) => available.includes(t);
  const call = (tool: string, input: Record<string, unknown> = {}, text = ""): RuleTurn => (has(tool) ? { tool, input, text } : { tool: null, input: {}, text: `The ${tool} tool is not available on this server.` });
  if (!u) return { tool: null, input: {}, text: "Say something like “how's the power?”, “can I run the iron?”, or “plan my power for today”." };

  // "Do all of them", "give me everything", "full rundown": every read-only view at once. Never arms or changes anything.
  if (/\b(all of (them|it|those|that)|do all|everything|every thing|full (picture|rundown|run down|report|update)|the works|rundown|run me through|overview)\b/.test(u) && !/\b(forget|remove|delete|cancel)\b/.test(u)) {
    const views = (["power_status", "plan_day", "outage_outlook", "energy_report"] as const).filter(has);
    if (views.length === 0) return { tool: null, input: {}, text: "None of the read-only tools are available on this server." };
    const [first, ...rest] = views.map((t) => ({ tool: t as string, input: t === "energy_report" ? { period: "week" } : {} }));
    return { tool: first.tool, input: first.input, also: rest, text: "Here's the full picture: the power right now, today's plan, how long we'd last without the grid, and the week so far." };
  }

  // Setup: "set up my solar: 4.5 kW array, 10 kWh battery, 5 kW inverter, 20% reserve"
  if (/\b(set ?up|setup|configure)\b/.test(u) && /\b(solar|system|array|battery|inverter)\b/.test(u)) {
    const arrayKw = num(u, /([\d.]+)\s*kw\s+(?:solar\s+|pv\s+)?(?:array|panels?|solar|roof)/) ?? num(u, /(?:array|panels?)\s+(?:of\s+)?([\d.]+)\s*kw/);
    const batteryKwh = num(u, /([\d.]+)\s*kwh/) ?? num(u, /battery\s+(?:of\s+)?([\d.]+)/);
    const inverterKw = num(u, /([\d.]+)\s*kw\s+inverter/) ?? num(u, /inverter\s+(?:of\s+)?([\d.]+)\s*kw/);
    const reserve = num(u, /([\d.]+)\s*%/);
    if (arrayKw && batteryKwh && inverterKw) return call("setup_system", { arrayKw, batteryKwh, inverterKw, reserveSocPct: reserve ?? 20 });
    return { tool: null, input: {}, text: "Tell me the array size in kilowatts, the battery in kilowatt-hours, the inverter in kilowatts and the reserve percentage — for example: set up my solar, 4.5 kW array, 10 kWh battery, 5 kW inverter, 20% reserve." };
  }
  // Tariff
  if (/\b(tariff|per (unit|kwh)|a unit|costs?)\b/.test(u) && /\b(grid|nepa|phcn|electric|unit|kwh)\b/.test(u)) {
    const perKwh = num(u, /([\d.]+)\s*(naira|ngn|₦|per|a unit|\/)/) ?? num(u, /(?:naira|ngn|₦)\s*([\d.]+)/);
    if (perKwh !== undefined) return call("set_tariff", { perKwh, currency: /\b(naira|ngn|₦)\b/.test(u) ? "NGN" : /\$|usd|dollar/.test(u) ? "USD" : /£|gbp|pound/.test(u) ? "GBP" : /€|eur/.test(u) ? "EUR" : "NGN" });
  }
  // Remember an appliance: "remember the iron uses 2000 watts for 30 minutes" / "add the kettle"
  if (/\b(remember|add|save|note)\b/.test(u) && !/\bplan\b/.test(u)) {
    const name = /\b(?:remember|add|save|note)\s+(?:that\s+)?(?:the\s+|my\s+|a\s+|an\s+)?([a-z/ ]+?)(?:\s+(?:uses|is|takes|draws|runs|for|at|with|needs)\b|\s*$|,)/.exec(u)?.[1]?.trim();
    const watts = num(u, /([\d.]+)\s*(?:w\b|watts?)/) ?? (num(u, /([\d.]+)\s*kw\b/) !== undefined ? num(u, /([\d.]+)\s*kw\b/)! * 1000 : undefined);
    const minutes = num(u, /([\d.]+)\s*(?:min|minutes?)\b/) ?? (num(u, /([\d.]+)\s*(?:h|hours?|hrs?)\b/) !== undefined ? num(u, /([\d.]+)\s*(?:h|hours?|hrs?)\b/)! * 60 : undefined);
    if (name) return call("add_appliance", { name, ...(watts !== undefined ? { watts } : {}), ...(minutes !== undefined ? { minutes } : {}) });
  }
  if (/\b(forget|remove|delete)\b/.test(u)) {
    const name = /\b(?:forget|remove|delete)\s+(?:the\s+|my\s+)?([a-z/ ]+?)\s*$/.exec(u)?.[1]?.trim();
    if (name) return call("remove_appliance", { name });
  }
  if (/\b(what|which)\b.*\bappliances?\b|\blist\b.*\bappliances?\b/.test(u)) return call("list_appliances");
  // Grid events
  if (/\b(grid|nepa|phcn|light)\b/.test(u) && /\b(went off|is off|gone|off now|just off|took)\b/.test(u)) return call("log_grid_event", { on: false });
  if (/\b(grid|nepa|phcn|light)\b/.test(u) && /\b(came back|is back|back on|came on|is on|on now|brought)\b/.test(u)) return call("log_grid_event", { on: true });
  // Reminders
  if (/\b(disarm|cancel|stop)\b/.test(u) && /\b(plan|reminders?)\b/.test(u)) return call("disarm_plan");
  if (/\b(arm|commit|remind me|set reminders?)\b/.test(u)) return call("arm_plan");
  // Can I run X (for N minutes)?
  const can = /\b(?:can|could|should|is it (?:ok|safe) to)\b.*?\b(?:run|use|switch on|turn on|put on|iron|wash)\b\s*(?:the\s+|my\s+)?([a-z/ ]+?)(?:\s+for\s+([\d.]+)\s*(min|minutes?|h|hours?)|\s+now|\s*$)/.exec(u) ?? /\bcan i iron\b/.exec(u);
  if (can) {
    const appliance = (can[1] ?? "iron").replace(/\b(now|today|tonight)\b/g, "").trim() || "iron";
    const minutes = can[2] ? Number(can[2]) * (/^h/.test(can[3] ?? "") ? 60 : 1) : undefined;
    return call("can_i_run", { appliance, ...(minutes ? { minutes } : {}) });
  }
  // Reports and outlooks
  if (/\b(how did we do|report|what did .*cost|how much .*(grid|solar|sun)|this week|yesterday|last 7 days)\b/.test(u)) {
    const period = /\byesterday\b/.test(u) ? "yesterday" : /\btoday\b/.test(u) ? "today" : "week";
    return call("energy_report", { period });
  }
  if (/\b(how long|last)\b.*\b(grid|nepa|light|outage|goes|off)\b|\b(outage|is there light|light tonight)\b/.test(u)) return call("outage_outlook");
  // Planning (before the time-word rules, so "plan tomorrow morning" plans)
  if (/\b(plan|schedule)\b/.test(u) || /\bwhen (should|can|do) i\b/.test(u)) return call("plan_day");
  // Briefings and "will it last": the forecast through the night, in one paragraph
  if (/\b(brief|briefing|outlook|summary|summarise|summarize|forecast|how are we for tonight|tonight|tomorrow|morning|overnight|night)\b/.test(u)
    || /\b(will|would|does|do)\b.*\b(last|hold|survive|make it)\b/.test(u) || /\benough (power|battery|charge|juice)\b/.test(u)) return call("evening_briefing");
  // Status (default for power questions)
  if (/\b(power|battery|solar|charge|status|how are we|how's|hows|how is|electricity|energy|inverter|update|situation|where are we|panels?|grid|light|nepa|phcn)\b/.test(u)) return call("power_status");
  // Greetings and "what can you do" get the menu; anything else gets the menu with examples (never the same dead end twice in a row is up to the host, which shows the hint chips).
  return { tool: null, input: {}, text: /\b(hi|hello|hey|help|what can you do|who are you|menu|options)\b/.test(u)
    ? "I'm Powerline. I can tell you how the power is, whether you can run an appliance, plan the day around the sun, arm reminders, report on the week, or give the overnight outlook — or say “give me everything”."
    : MENU };
}
