/**
 * Rule-based intent router — the no-model fallback for the simulated host, and a readable
 * statement of the phrasings Powerline expects. Pure, so it is unit-tested in isolation.
 */
export interface RuleTurn { tool: string | null; input: Record<string, unknown>; text: string; also?: Array<{ tool: string; input: Record<string, unknown> }> }

const MENU = "I didn't catch that. Try “how's the power?”, “can I run the iron for 30 minutes?”, “plan my power for today”, “how did we do this week?”, “will the battery last till morning?” — “how are my units?”, “buy 5,000 naira of units” — or “give me everything” for the full picture.";

const num = (s: string, re: RegExp) => { const m = re.exec(s); return m ? Number(m[1]) : undefined; };
// Punctuation goes, decimals stay ("4.5 kw" must survive; a trailing "." must not).
const clean = (s: string) => s.replace(/(\d),(?=\d{3}\b)/g, "$1").toLowerCase().replace(/[?!,;:]/g, " ").replace(/\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();

export function routeByRules(utterance: string, available: string[]): RuleTurn {
  const u = clean(utterance).slice(0, 400); // nothing spoken is longer; keeps every regex below linear in practice
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
  // Prepaid meter and units. Before the tariff and appliance rules: "add 5000 naira to my meter" is a purchase,
  // "my meter shows 40 units" is a balance. Purchases never carry a confirmation: the server always asks.
  const meterNo = /\b(\d[\d ]{9,16}\d)\b/.exec(u)?.[1]?.replace(/\s/g, "");
  const meterNumber = meterNo && meterNo.length >= 11 && meterNo.length <= 13 ? meterNo : undefined;
  const disco = /\b(ikeja electric|ikeja|ikedc|eko|ekedc|abuja|aedc|ibadan|ibedc|phed|port harcourt|kano|kedco|jos|kaduna|enugu|eedc|benin|bedc|aba|yola)\b/.exec(u)?.[1];
  const nairaAmt = (() => {
    const k = /(?:₦|\bn|\bngn\s*)?([\d.]+)\s*k\b/.exec(u); if (k) return Math.round(Number(k[1]) * 1000);
    return num(u, /([\d.]+)\s*(?:naira|ngn)\b/) ?? num(u, /(?:₦|\bngn\s*|\bn)([\d.]+)\b/);
  })();
  const notUnits = /\b(battery|batteries|inverter|panels?|solar|generator)\b/.test(u);
  // A bare number in a purchase ("top up my meter with 5000", "buy 5000") is naira when it is big enough to be money
  // and is not the meter number or a count of units.
  const notMoney = /\b(airtime|data|phone|card|recharge card)\b/.test(u) || /\b0[789][01](?: ?\d){8}\b/.test(u); // a Nigerian mobile number: airtime, not electricity
  const bareNaira = (() => {
    // Never the meter number (spaced or not) or a time ("before 1800"). A year is indistinguishable from ₦2,000; the dialog shows the amount.
    const rest = u.replace(/\b\d[\d ]{9,16}\d\b/g, " ").replace(/\b(?:before|after|at|by|in|since|from|till|until)\s+\d+\b/g, " ");
    for (const m of rest.matchAll(/\b(\d{3,7})(?!\s*(?:units?|kwh|%|w\b|watts?|minutes?|mins?|hours?))\b/g)) {
      const n = Number(m[1]);
      if (n >= 500 && n <= 1_000_000) return n;
    }
    return undefined;
  })();
  // "My units have finished" sets the balance to zero. Only units or the meter: "light is out" is a grid outage in Lagos.
  if (has("set_meter") && /\b(units?|meter)\b.{0,20}\b(finished|don finish|ran out|run out|are out|is empty|have finished|has finished|empty)\b|\bout of units\b|\blight don finish\b/.test(u)
    && !/\b(will|when|how long|yesterday|last (night|week)|nepa|phcn|grid|took)\b/.test(u) && !notUnits) return call("set_meter", { unitsLeft: 0 });
  const addToMeter = /\badd\b.{0,30}\b(?:to|on) (?:my |the )?meter\b/.test(u) && (nairaAmt !== undefined || bareNaira !== undefined);
  if (/\b(do|should|must) (i|we) (need to |have to )?(buy|top ?up|recharge)\b/.test(u) && !notUnits) return call("prepaid_units");
  if (((/\b(buy|top ?up|recharge|vend)\b/.test(u) && (/\b(units?|light|electricity|meter|token|naira|ngn|credit|prepaid)\b|₦|\d\s*k\b/.test(u) || (/^\s*(buy|top ?up|recharge)\s+(₦\s*)?\d/.test(u) && bareNaira !== undefined))) || addToMeter) && !notUnits && !notMoney) {
    // "Buy 20 units" is kWh, not naira; buy_units takes money. Ask rather than guess which the person meant.
    if (nairaAmt === undefined && /\d/.test(u) && /\b\d[\d.]*\s*(units?|kwh)\b/.test(u)) return { tool: null, input: {}, text: "Say it in naira — for example “buy 5,000 naira of units”. Or ask “how are my units?” and I'll suggest a top-up." };
    const amt = nairaAmt !== undefined && Number.isFinite(nairaAmt) ? nairaAmt : bareNaira;
    return call("buy_units", amt !== undefined ? { amount: Math.round(amt) } : {});
  }
  if (/\bmeter\b/.test(u) && (meterNumber || disco)) {
    const unitsLeft = num(u, /([\d.]+)\s*(?:units?|kwh)\b/);
    return call("set_meter", { ...(meterNumber ? { meterNumber } : {}), ...(disco ? { disco } : {}), ...(unitsLeft !== undefined && String(unitsLeft) !== meterNumber ? { unitsLeft } : {}) });
  }
  if (/\b(meter|units?)\b/.test(u) && /\b(shows?|reads?|has|have|left|remaining|balance is)\b/.test(u) && /\d/.test(u) && !/\bhow\b/.test(u)) {
    const unitsLeft = num(u, /([\d.]+)\s*(?:units?|kwh)\b/) ?? num(u, /(?:shows?|reads?|has|have|is)\s+([\d.]+)/);
    if (unitsLeft !== undefined) return call("set_meter", { unitsLeft });
  }
  // Balance questions only: "each unit costs 225" is a tariff, "units did we use yesterday" is a report, "can I run X on units" is can_i_run.
  if (/\b(my units|my meter|our units|the units|units? (left|remaining|last)|how (many|much) units?( do| have| are| is)?\b|will (my |our |the )?units|units? (run|running) out|prepaid|meter balance|(need|have) to buy)\b/.test(u)
    && !/\b(costs?|price|tariff|per (unit|kwh)|a unit|each unit|yesterday|this week|last week|today|did we|used)\b|\bcan i\b|\bcould i\b|\bwill (the|my|a|an) [a-z ]+ use\b/.test(u) && !notUnits) return call("prepaid_units");
  // Tariff
  if (/\b(tariff|per (unit|kwh)|a unit|costs?)\b/.test(u) && /\b(grid|nepa|phcn|electric|unit|kwh)\b/.test(u)) {
    const perKwh = num(u, /([\d.]+)\s*(naira|ngn|₦|per|a unit|\/)/) ?? num(u, /(?:naira|ngn|₦)\s*([\d.]+)/);
    if (perKwh !== undefined) return call("set_tariff", { perKwh, currency: /\b(naira|ngn|₦)\b/.test(u) ? "NGN" : /\$|usd|dollar/.test(u) ? "USD" : /£|gbp|pound/.test(u) ? "GBP" : /€|eur/.test(u) ? "EUR" : "NGN" });
  }
  // Grid events and reminders come before the appliance rules so "note NEPA took light" is an event, not an appliance.
  if (/\b(grid|nepa|phcn|light|power)\b/.test(u) && /\b(went off|is off|gone|off now|just off|took|taken|has gone|don go|no light)\b/.test(u)) return call("log_grid_event", { on: false });
  if (/\b(grid|nepa|phcn|light|power)\b/.test(u) && /\b(came back|is back|back on|came on|is on|on now|brought|dey|we got|just got|don come)\b/.test(u)) return call("log_grid_event", { on: true });
  if (/\b(disarm|cancel|stop|forget|delete|remove)\b/.test(u) && /\b(plan|reminders?|everything|all of (it|them|those))\b/.test(u)) return call("disarm_plan");
  if (/\b(arm|commit|remind me|set (up )?(a |the )?reminders?|reminders? (on|for|please))\b/.test(u)) return call("arm_plan");
  // "Switch off X" is not something Powerline can do; say so and offer the question it can answer.
  if (/\b(switch|turn|put) (off|on)\b|\bswitch off\b|\bturn off\b/.test(u) && !/\b(can|could|should|is it|safe)\b/.test(u)) {
    const what = /\b(?:switch|turn|put) (?:off|on)\s+(?:the\s+|my\s+)?([a-z/ ]{1,40}?)\s*$/.exec(u)?.[1]?.trim();
    return { tool: null, input: {}, text: `I can't switch appliances on or off — that needs a smart plug. I can tell you whether now is a good time${what ? ` to run the ${what}` : ""}: ask “can I run ${what ?? "it"} now?”` };
  }
  // Remember an appliance: "remember the iron uses 2000 watts for 30 minutes" / "add the kettle"
  if (/\b(remember|add|save|note)\b/.test(u) && !/\bplan\b/.test(u)) {
    const name = /\b(?:remember|add|save|note)\s+(?:that\s+)?(?:the\s+|my\s+|a\s+|an\s+)?([a-z/ ]+?)(?:\s+(?:uses|is|takes|draws|runs|for|at|with|needs)\b|\s*$|,)/.exec(u)?.[1]?.trim();
    const watts = num(u, /([\d.]+)\s*(?:w\b|watts?)/) ?? (num(u, /([\d.]+)\s*kw\b/) !== undefined ? num(u, /([\d.]+)\s*kw\b/)! * 1000 : undefined);
    const minutes = num(u, /([\d.]+)\s*(?:min|minutes?)\b/) ?? (num(u, /([\d.]+)\s*(?:h|hours?|hrs?)\b/) !== undefined ? num(u, /([\d.]+)\s*(?:h|hours?|hrs?)\b/)! * 60 : undefined);
    if (name) return call("add_appliance", { name, ...(watts !== undefined ? { watts } : {}), ...(minutes !== undefined ? { minutes } : {}) });
  }
  if (/\b(forget|remove|delete)\b/.test(u)) {
    const name = /\b(?:forget|remove|delete)\s+(?:the\s+|my\s+)?([a-z/]+(?: [a-z/]+){0,3})\s*$/.exec(u)?.[1]?.trim();
    if (name && !/^(everything|all|it|them)$/.test(name)) return call("remove_appliance", { name });
  }
  if (/\b(what|which)\b.*\bappliances?\b|\blist\b.*\bappliances?\b/.test(u)) return call("list_appliances");
  // Reports come before "can I run": "could you run the energy report" is a report.
  if (/\b(how did we do|report|what did .{0,40}cost|how much .{0,40}(grid|solar|sun)|this week|yesterday|last 7 days)\b/.test(u)) {
    const period = /\byesterday\b/.test(u) ? "yesterday" : /\btoday\b/.test(u) ? "today" : "week";
    return call("energy_report", { period });
  }
  // Can I run X (for N minutes)?
  const can = /\b(?:can|could|should|is it (?:ok|safe) to)\b.{0,40}?\b(?:run|use|switch on|turn on|put on|iron|wash)\b\s*(?:the\s+|my\s+)?([a-z/]+(?: [a-z/]+){0,4}?)(?:\s+for\s+([\d.]+)\s*(min|minutes?|h|hours?)|\s+now|\s+right now|\s+tonight|\s+today|\s*$)/.exec(u) ?? /\bcan i iron\b/.exec(u);
  if (can) {
    const appliance = (can[1] ?? "iron").replace(/\b(now|today|tonight)\b/g, "").trim() || "iron";
    const minutes = can[2] ? Number(can[2]) * (/^h/.test(can[3] ?? "") ? 60 : 1) : undefined;
    return call("can_i_run", { appliance, ...(minutes ? { minutes } : {}) });
  }
  // Outlooks
  if (/\b(how long|last)\b.{0,60}\b(grid|nepa|light|outage|goes|off)\b|\b(outage|is there light|light tonight)\b/.test(u)) return call("outage_outlook");
  // Planning (before the time-word rules, so "plan tomorrow morning" plans)
  if (/\b(plan|schedule)\b/.test(u) || /\bwhen (should|can|do) i\b/.test(u)) return call("plan_day");
  // Briefings and "will it last": the forecast through the night, in one paragraph
  if (/\b(brief|briefing|outlook|summary|summarise|summarize|forecast|how are we for tonight|tonight|tomorrow|morning|overnight|night)\b/.test(u)
    || /\b(will|would|does|do)\b.{0,60}\b(last|hold|survive|make it)\b/.test(u) || /\benough (power|battery|charge|juice)\b/.test(u)) return call("evening_briefing");
  // Status (default for power questions)
  if (/\b(power|battery|solar|charge|status|how are we|how's|hows|how is|electricity|energy|inverter|update|situation|where are we|panels?|grid|light|nepa|phcn)\b/.test(u)) return call("power_status");
  // Greetings and "what can you do" get the menu; anything else gets the menu with examples (never the same dead end twice in a row is up to the host, which shows the hint chips).
  return { tool: null, input: {}, text: /\b(hi|hello|hey|help|what can you do|who are you|menu|options)\b/.test(u)
    ? "I'm Powerline. I can tell you how the power is, whether you can run an appliance, plan the day around the sun, arm reminders, report on the week, track and buy prepaid units, or give the overnight outlook — or say “give me everything”."
    : MENU };
}
