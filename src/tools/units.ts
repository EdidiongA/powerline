/**
 * Prepaid units: set_meter, prepaid_units, buy_units.
 *
 * buy_units is the only tool in Powerline that can spend money, so it is the most guarded:
 *   - nothing is bought without the household saying yes — through MCP elicitation when the host
 *     can ask, otherwise through a quote that must be confirmed in a second call within 5 minutes;
 *     an elicitation that times out, is declined, or comes back unreadable buys nothing;
 *   - a per-purchase ceiling and a rolling 24-hour ceiling (UNITS_MAX_NGN, UNITS_DAILY_NGN), checked
 *     inside the same conditional write that records the purchase, so parallel calls cannot race past it;
 *   - every purchase is recorded as pending BEFORE the vendor is called, under a fresh request id;
 *     an unclear answer stays pending and is asked about again with the same id — never bought twice;
 *   - the vendor's name (simulated / vtpass-sandbox) is in every reply.
 */
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { forecast } from "../forecast.js";
import { assess, type SessionContext } from "../situation.js";
import { getHousehold, updateHousehold, type Household, type Purchase } from "../store/index.js";
import { hourLabel } from "../config.js";
import { alertChannelFor } from "../push.js";
import { forecastWithoutUnits, gridUseSince, rateFrom, unitsOutlook, type UnitsOutlook } from "../units.js";
import { DISCOS, discoKey, formatToken, maskMeter, newRequestId, normalizeMeter, unitsFor, vendorFromEnv, type UnitsVendor, type Vend } from "../vending.js";

const envNaira = (name: string, dflt: number) => { const n = Number(process.env[name]); return process.env[name]?.trim() && Number.isFinite(n) && n > 0 ? n : dflt; };
export const UNITS_MAX_NGN = envNaira("UNITS_MAX_NGN", 20_000);
export const UNITS_DAILY_NGN = envNaira("UNITS_DAILY_NGN", 50_000);
const QUOTE_TTL_MS = 5 * 60_000;
const MIN_AMOUNT = 500;

let processVendor: UnitsVendor | null = null;
/** One vendor per process (the simulated one remembers what it sold). Tests inject their own through createServer. */
export const defaultVendor = (): UnitsVendor => (processVendor ??= vendorFromEnv());

const naira = (v: number) => `₦${Math.round(v).toLocaleString("en")}`;
const kwh = (v: number) => { const r = Math.round(v * 10) / 10; return `${r >= 100 ? Math.round(r) : r} kWh`; };
const vendorNote = (v: UnitsVendor) => (v.simulated ? " (Simulated vendor: no real money moves.)" : v.name === "vtpass-sandbox" ? " (VTpass sandbox: test money only.)" : "");

class LimitError extends Error {}
const newQuoteId = () => `q${randomBytes(3).toString("hex")}`;

/** Purchases whose vendor call is still running in this process: never requeried meanwhile. */
const inFlight = new Set<string>();
/** Older than any vendor call can run (VTpass: 20 s timeout), so a requery cannot overtake the purchase it asks about. */
const SETTLE_AFTER_MS = 90_000;
/** A requery that says "failed" sooner than this is not trusted: VTpass answers "invalid request id" until the pay has landed. */
const FAIL_AFTER_MS = 15 * 60_000;

/** Add delivered units to the meter's balance: the current estimate (last reading minus grid use since), plus the new units. */
function creditUnits(hh: Household, meterNo: string, units: number, nowIso: string): void {
  const m = hh.meter;
  if (!m || m.number !== meterNo) return;
  const known = typeof m.unitsKwh === "number" && typeof m.unitsAt === "string";
  const est = known ? Math.max(0, m.unitsKwh! - gridUseSince(hh.samples ?? [], m.unitsAt!, nowIso)) : 0;
  m.unitsKwh = Math.round((est + units) * 10) / 10;
  m.unitsAt = nowIso;
  if (!known) m.lowerBound = true; // whatever was on the meter before is unknown, so this is a floor until the household reads it
}

interface Settled { pending: Purchase[]; delivered: Purchase[] }
/** Ask the vendor about purchases still pending, and settle them. Returns what is still unsettled, and what THIS call saw delivered (to announce once). */
async function settlePending(userId: string, vendor: UnitsVendor, nowIso: string): Promise<Settled> {
  const h = await getHousehold(userId);
  const delivered: Purchase[] = [];
  for (const p of (h.purchases ?? []).filter((x) => x.status === "pending")) {
    const age = Date.now() - Date.parse(p.at);
    if (inFlight.has(p.ref) || !(age >= SETTLE_AFTER_MS)) continue;
    let r: Vend;
    try { r = await vendor.requery(p.ref); } catch (e) { console.error(`[units] requery ${p.ref} failed: ${(e as Error).message}`); continue; }
    if (r.status === "pending" || (r.status === "failed" && age < FAIL_AFTER_MS)) continue;
    let mine = false;
    let settledUnits: number | undefined;
    await updateHousehold(userId, (hh) => {
      mine = false; // the mutation can be re-applied on a write conflict
      const target = hh.purchases?.find((x) => x.ref === p.ref);
      if (!target || target.status !== "pending") return; // another session settled it
      mine = true;
      target.status = r.status;
      if (r.token) target.token = r.token;
      // A vendor that confirms without a units figure still delivered units: estimate them, exactly as the direct path does.
      const units = r.units ?? (r.status === "delivered" ? unitsFor(p.amount, rateFrom(hh.tariff).rate) : undefined);
      if (units !== undefined) target.units = units;
      if (r.status === "delivered") delete target.message; // "processing" no longer describes it
      else if (r.message) target.message = r.message;
      if (r.vendorRef) target.vendorRef = r.vendorRef;
      if (r.status === "delivered" && units !== undefined) creditUnits(hh, p.meter, units, nowIso);
      settledUnits = units;
    });
    if (mine && r.status === "delivered") delivered.push({ ...p, status: "delivered", token: r.token, units: settledUnits });
  }
  const pending = ((await getHousehold(userId)).purchases ?? []).filter((x) => x.status === "pending");
  return { pending, delivered };
}

/** A purchase that settled after the fact: tell the household its token, in the reply and as a pushed alert. */
function announceSettled(server: McpServer, list: Purchase[]): string {
  for (const p of list) {
    const token = p.token ? formatToken(p.token) : "(no token returned; check your SMS)";
    alertChannelFor(server).send("purchase", `Your ${naira(p.amount)} purchase for meter ${maskMeter(p.meter)} went through. Token: ${token}${p.units !== undefined ? ` — ${kwh(p.units)}` : ""}.`, { amount: p.amount, ref: p.ref }).catch(() => {});
  }
  return list.map((p) => `Your earlier ${naira(p.amount)} purchase went through. Token: ${p.token ? formatToken(p.token) : "not returned — check your SMS"}${p.units !== undefined ? ` (${kwh(p.units)})` : ""}. `).join("");
}

function outlookText(o: UnitsOutlook, localHour: number, afterRunout: { minSocPct: number; hitsFloor: boolean } | null, reserve: number): string {
  const parts: string[] = [];
  if (o.balanceKwh === null) parts.push(`I don't know the meter's balance yet — tell me how many units it shows.`);
  else if (o.balanceKwh <= 0.05) parts.push(o.lowerBound ? `The meter may be nearly out of units — tell me what it shows for an exact figure.` : `The meter is out of units.`);
  else parts.push(`${o.lowerBound ? "At least" : "About"} ${kwh(o.balanceKwh)} left on the meter${o.usedSinceKwh > 0 ? ` (≈ ${kwh(o.usedSinceKwh)} used since the last reading)` : ""}.`);
  parts.push(o.needNext24hKwh > 0 ? `The next 24 hours need about ${kwh(o.needNext24hKwh)} from the grid.` : `No grid use is expected in the next 24 hours.`);
  if (o.runsOutHour !== null) {
    const fate = !afterRunout ? "" : afterRunout.minSocPct <= 0 ? "runs flat" : afterRunout.hitsFloor && reserve > 0 ? `falls to ${afterRunout.minSocPct}%, under your ${reserve}% reserve` : `bottoms out at ${afterRunout.minSocPct}%`;
    const empty = o.balanceKwh !== null && o.balanceKwh <= 0.05 && !o.lowerBound;
    const when = empty ? "Even when the grid is on, the house can't use it" : o.runsOutHour === 0 ? "The units run out within the hour while the grid is on" : `The units run out around ${hourLabel(localHour, o.runsOutHour)} while the grid is on`;
    parts.push(`${when}${fate ? `; ${empty ? "the battery carries the house and" : "after that the battery carries the house and"} ${fate}` : ""}.`);
  } else if (o.balanceKwh !== null && o.needNext24hKwh > 0) parts.push(`That covers the next 24 hours.`);
  if (o.suggestedAmount !== null) parts.push(`A top-up of ${naira(o.suggestedAmount)} covers the next day with a margin${o.rateAssumed ? ` (at an assumed ${naira(o.ratePerKwh)}/kWh — ${o.tariffCurrency ? `your tariff is in ${o.tariffCurrency}, not naira` : "set your tariff for an exact figure"})` : ""}.`);
  return parts.join(" ");
}

export function registerUnitsTools(server: McpServer, ctx: SessionContext, vendor: UnitsVendor = defaultVendor()): void {
  // Quotes for hosts that cannot be asked (no elicitation): created on the first call, spent on the confirming one.
  const quotes = new Map<string, { amount: number; meter: string; expires: number }>();

  server.registerTool("set_meter", {
    title: "Set the prepaid meter",
    description: "Store the household's prepaid electricity meter (number and distribution company, verified with the vendor) and/or the units it currently shows. Use when the user says their meter number, their DisCo (Ikeja Electric, Eko, AEDC, IBEDC, PHED…), or 'my meter shows 40 units'.",
    inputSchema: z.object({
      meterNumber: z.string().trim().max(30).optional().describe("11–13 digit prepaid meter number; spaces are fine"),
      disco: z.string().trim().max(60).optional().describe("Distribution company, e.g. 'Ikeja Electric', 'IKEDC', 'Eko', 'AEDC'"),
      unitsLeft: z.number().min(0).max(100_000).optional().describe("Units (kWh) the meter shows right now"),
    }),
    annotations: { idempotentHint: true },
  }, async ({ meterNumber, disco, unitsLeft }) => {
    const h = await getHousehold(ctx.userId);
    const nowIso = await ctx.source.current().then((t) => (Number.isNaN(Date.parse(t.at)) ? new Date().toISOString() : t.at)).catch(() => new Date().toISOString());
    if (meterNumber === undefined && disco === undefined) {
      if (unitsLeft === undefined) return { content: [{ type: "text", text: "Tell me the meter number and distribution company, or how many units the meter shows." }], isError: true };
      if (!h.meter) return { content: [{ type: "text", text: "I need the meter number and distribution company first — for example “my meter is 1111 1111 1111 1, Ikeja Electric”." }], isError: true };
      await updateHousehold(ctx.userId, (hh) => { if (hh.meter) { hh.meter.unitsKwh = unitsLeft; hh.meter.unitsAt = nowIso; delete hh.meter.lowerBound; } });
      return { content: [{ type: "text", text: `Noted: ${kwh(unitsLeft)} on meter ${maskMeter(h.meter.number)}. I'll count down from there using the grid use I record.` }] };
    }
    const number = meterNumber !== undefined ? normalizeMeter(meterNumber) : h.meter?.number ?? null;
    if (!number) return { content: [{ type: "text", text: meterNumber !== undefined ? `"${meterNumber}" doesn't look like a prepaid meter number — they are 11 to 13 digits.` : "I need the meter number too." }], isError: true };
    const key = disco !== undefined ? discoKey(disco) : h.meter?.disco ?? null;
    if (!key) return { content: [{ type: "text", text: disco !== undefined ? `I don't recognise "${disco}". Distribution companies I know: ${Object.values(DISCOS).map((d) => d.name).join(", ")}.` : "Which distribution company is the meter with (Ikeja Electric, Eko, AEDC…)?" }], isError: true };
    let check;
    try { check = await vendor.verify(number, key); } catch (e) {
      return { content: [{ type: "text", text: `Couldn't reach the vending service to check the meter (${(e as Error).message}). Nothing was saved; try again in a minute.` }], isError: true };
    }
    if (!check.ok) return { content: [{ type: "text", text: `${DISCOS[key].name} did not recognise meter ${maskMeter(number)}: ${(check.error ?? "not found").replace(/\.\s*$/, "")}. Nothing was saved.` }], isError: true };
    await updateHousehold(ctx.userId, (hh) => {
      const same = hh.meter?.number === number; // a corrected DisCo is still the same meter and the same balance
      hh.meter = { number, disco: key, ...(check.customerName ? { customerName: check.customerName } : {}), ...(check.minAmount ? { minAmount: check.minAmount } : {}),
        ...(unitsLeft !== undefined ? { unitsKwh: unitsLeft, unitsAt: nowIso } : same && hh.meter?.unitsKwh !== undefined ? { unitsKwh: hh.meter.unitsKwh, unitsAt: hh.meter.unitsAt, ...(hh.meter.lowerBound ? { lowerBound: true } : {}) } : {}) };
    });
    return {
      content: [{ type: "text", text: `Meter ${maskMeter(number)} verified with ${DISCOS[key].name}${check.customerName ? `: ${check.customerName}` : ""}.${unitsLeft !== undefined ? ` Balance ${kwh(unitsLeft)}.` : " Tell me how many units it shows and I'll track the balance."}${vendorNote(vendor)}` }],
      structuredContent: { meter: maskMeter(number), disco: DISCOS[key].name, customerName: check.customerName ?? null, vendor: vendor.name },
    };
  });

  server.registerTool("prepaid_units", {
    title: "Prepaid units outlook",
    description: "How long the prepaid meter's units will last: estimated balance, the grid energy the next 24 hours need, when the units run out and what that does to the battery, and a suggested top-up. Use for 'how many units do I have', 'will my units last', 'do I need to buy light/units'.",
    inputSchema: z.object({}),
    annotations: { idempotentHint: true }, // not read-only: it settles purchases the vendor has since completed
  }, async () => {
    const { input, localHour, t, profile } = await assess(ctx);
    const settled = await settlePending(ctx.userId, vendor, t.at);
    const stillPending = settled.pending;
    const earlier = announceSettled(server, settled.delivered);
    const h = await getHousehold(ctx.userId); // after settling, so a just-delivered purchase counts
    if (!h.meter) return { content: [{ type: "text", text: earlier + "I don't have your prepaid meter yet. Tell me the meter number and distribution company — for example “my meter is 1111 1111 1111 1, Ikeja Electric” — and how many units it shows." }], structuredContent: { meter: null } };
    const base = forecast(input);
    const o = unitsOutlook({ meter: h.meter, samples: h.samples ?? [], base, nowIso: t.at, tariff: h.tariff });
    const after = o.runsOutHour !== null ? forecastWithoutUnits(input, o.runsOutHour) : null;
    const pendingNote = stillPending.length ? ` A ${naira(stillPending[0].amount)} purchase is still processing; I'll keep checking.` : "";
    return {
      content: [{ type: "text", text: earlier + outlookText(o, localHour, after, profile.reserveSocPct) + pendingNote }],
      structuredContent: { ...o, meter: maskMeter(h.meter.number), disco: DISCOS[h.meter.disco]?.name ?? h.meter.disco, afterRunout: after ? { minSocPct: after.minSocPct, hitsFloor: after.hitsFloor } : null, pending: stillPending.length, vendor: vendor.name },
    };
  });

  server.registerTool("buy_units", {
    title: "Buy prepaid electricity units",
    description: `Buy prepaid electricity units for the household's meter and return the token to enter on the meter. ONLY when the user asks to buy or top up. The user is always asked to confirm before anything is bought: hosts with elicitation get a yes/no question; other hosts get a quote, and buy_units must be called again with its quoteId ONLY after the user explicitly says yes. Omit amount to buy the suggested top-up. Limits: ${naira(UNITS_MAX_NGN)} per purchase, ${naira(UNITS_DAILY_NGN)} per 24 hours.`,
    inputSchema: z.object({
      amount: z.number().int("Whole naira only").min(MIN_AMOUNT, `The minimum purchase is ${naira(MIN_AMOUNT)}`).max(10_000_000).optional().describe("Naira to spend; omit for the suggested top-up"),
      quoteId: z.string().trim().max(40).optional().describe("Only on hosts without elicitation: the quote the user has just explicitly confirmed"),
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }, // it spends money: hosts that confirm destructive tools should confirm this one
  }, async ({ amount, quoteId }) => {
    const { input, localHour, t } = await assess(ctx);
    const settled = await settlePending(ctx.userId, vendor, t.at);
    const stillPending = settled.pending;
    const earlier = announceSettled(server, settled.delivered);
    if (earlier) return { content: [{ type: "text", text: `${earlier}Ask again if you still want to buy more.` }], structuredContent: { bought: false, reason: "earlier-purchase-settled", settled: settled.delivered.map((p) => ({ ref: p.ref, amount: p.amount, token: p.token ?? null })) } };
    if (stillPending.length) return { content: [{ type: "text", text: `A ${naira(stillPending[0].amount)} purchase is still processing with the vendor. I won't buy again until it settles (at most 15 minutes) — ask “how are my units?” in a couple of minutes.` }], structuredContent: { bought: false, reason: "pending" } };
    const h = await getHousehold(ctx.userId);
    const meter = h.meter;
    if (!meter) return { content: [{ type: "text", text: "I need the prepaid meter first — say “my meter is 1111 1111 1111 1, Ikeja Electric”." }], structuredContent: { bought: false, reason: "no-meter" } };
    const o = unitsOutlook({ meter, samples: h.samples ?? [], base: forecast(input), nowIso: t.at, tariff: h.tariff });

    // Second call on a host without elicitation: the quote carries the amount the user agreed to.
    const quote = quoteId ? quotes.get(quoteId) : undefined;
    if (quoteId && (!quote || quote.expires < Date.now() || quote.meter !== meter.number)) {
      quotes.delete(quoteId);
      return { content: [{ type: "text", text: "That quote has expired or doesn't match the meter. Nothing was bought; ask again for a fresh quote." }], structuredContent: { bought: false, reason: "quote-expired" } };
    }
    const spend = quote?.amount ?? amount ?? o.suggestedAmount;
    if (spend === null || spend === undefined) {
      return { content: [{ type: "text", text: `${outlookText(o, localHour, null, 0)} No top-up is needed — say an amount if you want to buy anyway.` }], structuredContent: { bought: false, reason: "not-needed", outlook: o } };
    }
    const minimum = Math.max(MIN_AMOUNT, meter.minAmount ?? 0);
    if (spend < minimum) return { content: [{ type: "text", text: `The minimum purchase for ${DISCOS[meter.disco]?.name ?? "this meter"} is ${naira(minimum)}. Nothing was bought.` }], structuredContent: { bought: false, reason: "under-minimum", minimum } };
    if (spend > UNITS_MAX_NGN) return { content: [{ type: "text", text: `${naira(spend)} is over the ${naira(UNITS_MAX_NGN)} limit for one purchase. Nothing was bought.` }], structuredContent: { bought: false, reason: "over-limit" } };
    const dayAgo = Date.now() - 86_400_000;
    const spent24h = (h.purchases ?? []).filter((p) => p.status !== "failed" && Date.parse(p.at) > dayAgo).reduce((a, p) => a + p.amount, 0);
    if (spent24h + spend > UNITS_DAILY_NGN) return { content: [{ type: "text", text: `That would take today's prepaid spending to ${naira(spent24h + spend)}, over the ${naira(UNITS_DAILY_NGN)} daily limit. Nothing was bought.` }], structuredContent: { bought: false, reason: "daily-limit" } };

    const { rate, assumed } = rateFrom(h.tariff);
    const disco = DISCOS[meter.disco]?.name ?? meter.disco;
    const about = `about ${kwh(unitsFor(spend, rate))} at ${naira(rate)}/kWh${assumed ? " (assumed)" : ""}, including 7.5% VAT`;
    const question = `Buy ${naira(spend)} of electricity for meter ${maskMeter(meter.number)} (${disco}${meter.customerName ? `, ${meter.customerName}` : ""})? That is ${about}.${vendorNote(vendor)}`;

    if (!quote) {
      if (server.server.getClientCapabilities()?.elicitation) {
        let yes = false;
        try {
          const ask = await server.server.elicitInput({
            message: question,
            requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: `Buy ${naira(spend)} of units`, description: "Yes buys now; no buys nothing." } }, required: ["confirm"] },
          }, { timeout: 120_000 });
          yes = ask.action === "accept" && (ask.content as { confirm?: unknown } | undefined)?.confirm === true;
        } catch (e) {
          // Unlike arm_plan, a failed question never proceeds: this tool spends money. A timeout buys nothing;
          // a host that advertised elicitation but cannot answer gets a quote to confirm instead.
          const msg = (e as Error).message ?? "";
          if (/timed? ?out|timeout/i.test(msg)) return { content: [{ type: "text", text: "No answer arrived, so nothing was bought." }], structuredContent: { bought: false, reason: "no-answer" } };
          console.error(`[buy_units] elicitation failed (${msg}); falling back to a quote`);
          const id = newQuoteId();
          quotes.set(id, { amount: spend, meter: meter.number, expires: Date.now() + QUOTE_TTL_MS });
          return { content: [{ type: "text", text: `${question} Say “yes” to confirm (quote ${id}, valid 5 minutes).` }], structuredContent: { bought: false, needsConfirmation: true, quoteId: id, amount: spend } };
        }
        if (!yes) return { content: [{ type: "text", text: "Okay — nothing was bought." }], structuredContent: { bought: false, reason: "declined" } };
      } else {
        const id = newQuoteId();
        quotes.set(id, { amount: spend, meter: meter.number, expires: Date.now() + QUOTE_TTL_MS });
        return { content: [{ type: "text", text: `${question} Say “yes” to confirm (quote ${id}, valid 5 minutes).` }], structuredContent: { bought: false, needsConfirmation: true, quoteId: id, amount: spend } };
      }
    } else quotes.delete(quoteId!); // a quote is spent once, whatever happens next

    // Record the intent first, with the limits checked inside the same write.
    const ref = newRequestId();
    try {
      await updateHousehold(ctx.userId, (hh) => {
        const since = Date.now() - 86_400_000;
        const total = (hh.purchases ?? []).filter((p) => p.status !== "failed" && Date.parse(p.at) > since).reduce((a, p) => a + p.amount, 0);
        if (total + spend > UNITS_DAILY_NGN) throw new LimitError(`over the ${naira(UNITS_DAILY_NGN)} daily limit`);
        if ((hh.purchases ?? []).some((p) => p.status === "pending")) throw new LimitError("another purchase is still processing");
        (hh.purchases ??= []).push({ ref, at: new Date().toISOString(), amount: spend, meter: meter.number, vendor: vendor.name, status: "pending" });
      });
    } catch (e) {
      if (e instanceof LimitError) return { content: [{ type: "text", text: `Not bought: ${e.message}.` }], structuredContent: { bought: false, reason: "limit" } };
      throw e;
    }

    let r: Vend;
    inFlight.add(ref);
    try { r = await vendor.buy({ ref, meter: meter.number, disco: meter.disco, amount: spend, ratePerKwh: rate }); }
    catch (e) { r = { status: "pending", message: (e as Error).message }; } // an adapter that throws: the vend may have happened, so requery later
    finally { inFlight.delete(ref); }
    const units = r.units ?? unitsFor(spend, rate);
    let saved = true, balance: number | null = null;
    try {
      const after = await updateHousehold(ctx.userId, (hh) => {
        const p = hh.purchases?.find((x) => x.ref === ref);
        if (!p || p.status === "delivered") return;                 // already settled as delivered
        if (p.status !== "pending" && r.status !== "delivered") return; // the vendor's own "delivered" outranks anything a requery guessed
        p.status = r.status;
        if (r.token) p.token = r.token;
        if (r.units !== undefined) p.units = r.units;
        if (r.message) p.message = r.message;
        if (r.vendorRef) p.vendorRef = r.vendorRef;
        if (r.status === "delivered") creditUnits(hh, meter.number, units, t.at);
      });
      balance = after.meter?.number === meter.number ? after.meter.unitsKwh ?? null : null;
    } catch (e) {
      // The money has moved (or not) either way; never hide a token behind a storage error.
      saved = false;
      console.error(`[buy_units] could not record ${ref} (${r.status}): ${(e as Error).message}`);
    }
    const unsaved = saved ? "" : " (I couldn't save this purchase — write the token down.)";

    if (r.status === "failed") return { content: [{ type: "text", text: `The purchase failed: ${r.message ?? "the vendor declined it"}. No token was issued.${vendorNote(vendor)}` }], structuredContent: { bought: false, reason: "failed", message: r.message ?? null, ref, saved } };
    if (r.status === "pending") return { content: [{ type: "text", text: `The vendor accepted the ${naira(spend)} purchase but hasn't issued the token yet. I'll check again — ask “how are my units?” in a minute. I won't buy again until it settles.${vendorNote(vendor)}` }], structuredContent: { bought: false, reason: "pending", ref } };

    const token = r.token ? formatToken(r.token) : "(the vendor did not return a token; check your SMS)";
    alertChannelFor(server).send("purchase", `Token for meter ${maskMeter(meter.number)}: ${token} — ${kwh(units)}. Enter it on the meter keypad.`, { amount: spend, units, ref }).catch(() => {});
    const bal = balance ?? (o.balanceKwh ?? 0) + units;
    const balText = o.balanceKwh === null || o.lowerBound ? `Balance now at least ${kwh(bal)}.` : `Balance now about ${kwh(bal)}${bal >= o.needNext24hKwh ? ", enough for the next 24 hours" : ""}.`;
    return {
      content: [{ type: "text", text: `Bought ${naira(spend)} of units for meter ${maskMeter(meter.number)}: ${kwh(units)}. Token: ${token}. Enter it on the meter keypad. ${balText}${unsaved}${vendorNote(vendor)}` }],
      structuredContent: { bought: true, amount: spend, units, token: r.token ?? null, ref, vendorRef: r.vendorRef ?? null, balanceKwh: Math.round(bal * 10) / 10, saved, vendor: vendor.name, simulated: vendor.simulated },
    };
  });
}
