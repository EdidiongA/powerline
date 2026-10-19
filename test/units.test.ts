/**
 * Prepaid units: the arithmetic (units.ts), the vendors (vending.ts, VTpass replayed through a fake fetch),
 * the stored record, and the three tools over a real MCP client — including every way buy_units must NOT buy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { DiskStore } from "../src/store/disk.js";
import { getHousehold, setStore, updateHousehold } from "../src/store/index.js";
import { sanitize, emptyHousehold, type Sample } from "../src/store/types.js";
import type { TelemetrySource } from "../src/telemetry/types.js";
import { forecast, type ForecastInput } from "../src/forecast.js";
import { forecastWithoutUnits, gridUseSince, roundTopUp, unitsOutlook } from "../src/units.js";
import { SimulatedVendor, VtpassVendor, VTPASS_SANDBOX, discoKey, formatToken, maskMeter, newRequestId, normalizeMeter, unitsFor, vendorFromEnv, type UnitsVendor, type Vend } from "../src/vending.js";

const METER = "1111111111111";

// ---------------------------------------------------------------- pure helpers

test("discoKey understands what people call their distribution company", () => {
  for (const s of ["Ikeja Electric", "IKEDC", "ikeja", "ikeja-electric", "Ikeja Electric Plc"]) assert.equal(discoKey(s), "ikeja", s);
  assert.equal(discoKey("Eko Electricity Distribution Company"), "eko");
  assert.equal(discoKey("AEDC"), "abuja");
  assert.equal(discoKey("Port Harcourt"), "portharcourt");
  assert.equal(discoKey("PHED"), "portharcourt");
  assert.equal(discoKey("IBEDC"), "ibadan");
  assert.equal(discoKey("Lagos Gas"), null);
  assert.equal(discoKey(""), null);
});

test("meter numbers: 11–13 digits, spaces and dashes allowed; masked when read back", () => {
  assert.equal(normalizeMeter("1111 1111 1111 1"), METER);
  assert.equal(normalizeMeter("0101-2345-678"), "01012345678");
  assert.equal(normalizeMeter("1234"), null);
  assert.equal(normalizeMeter("11111111111111"), null);
  assert.equal(normalizeMeter("1111abc111111"), null);
  assert.equal(maskMeter(METER), "…1111");
});

test("VTpass request ids start with YYYYMMDDHHII in Lagos time and never repeat", () => {
  const id = newRequestId(new Date("2026-10-01T23:30:00Z")); // 00:30 on the 2nd in Lagos
  assert.match(id, /^202610020030[a-z0-9]+$/);
  assert.ok(id.length >= 12 && id.length <= 40);
  assert.notEqual(newRequestId(), newRequestId());
});

test("tokens print in groups of four; units include 7.5 % VAT", () => {
  assert.equal(formatToken("12345678901234567890"), "1234-5678-9012-3456-7890");
  assert.equal(formatToken("Token : 1234 5678 9012 3456 7890"), "1234-5678-9012-3456-7890");
  assert.equal(formatToken("abc"), "abc");
  assert.equal(unitsFor(5000, 225), 20.7);
  assert.equal(roundTopUp(1), 1000);
  assert.equal(roundTopUp(2600), 3000);
});

// ---------------------------------------------------------------- outlook

const NIGHT_AT = "2026-10-01T20:00:00.000Z";
/** 24 h with the grid on for the first 6 hours of a 600 W night load and no sun. */
const gridEvening = (): ForecastInput => ({
  profile: { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 },
  socPct: 60,
  pvForecastW: Array(24).fill(0),
  loadForecastW: Array(24).fill(600),
  gridForecast: Array.from({ length: 24 }, (_, i) => i < 6),
});

test("gridUseSince counts only grid-on hours after the reading, from the next hour slot", () => {
  const samples: Sample[] = [
    { at: "2026-10-01T17:00:00.000Z", pv_w: 0, load_w: 1000, soc_pct: 50, grid_on: true },  // the reading's own hour: skipped
    { at: "2026-10-01T18:00:00.000Z", pv_w: 200, load_w: 1000, soc_pct: 50, grid_on: true }, // 0.8 kWh
    { at: "2026-10-01T19:00:00.000Z", pv_w: 0, load_w: 900, soc_pct: 50, grid_on: false },   // grid off: battery's
    { at: "2026-10-01T21:00:00.000Z", pv_w: 0, load_w: 900, soc_pct: 50, grid_on: true },    // after now: skipped
  ];
  assert.equal(gridUseSince(samples, "2026-10-01T17:20:00.000Z", NIGHT_AT), 0.8);
  assert.equal(gridUseSince(samples, "nonsense", NIGHT_AT), 0);
  // Read exactly on the hour: that hour's sample is all after the reading. The current hour is the forecast's, not history's.
  assert.equal(gridUseSince(samples, "2026-10-01T18:00:00.000Z", NIGHT_AT), 0.8);
  assert.equal(gridUseSince(samples, "2026-10-01T17:20:00.000Z", "2026-10-01T18:30:00.000Z"), 0);
});

test("unitsOutlook: balance, the hour they run out, and a top-up that covers the day", () => {
  const base = forecast(gridEvening()); // grid supplies 0.6 kWh/h for 6 h = 3.6 kWh
  const meter = { number: METER, disco: "ikeja", unitsKwh: 2, unitsAt: NIGHT_AT };
  const o = unitsOutlook({ meter, samples: [], base, nowIso: NIGHT_AT, tariff: { currency: "NGN", perKwh: 200 } });
  assert.equal(o.known, true);
  assert.equal(o.balanceKwh, 2);
  assert.equal(o.needNext24hKwh, 3.6);
  assert.equal(o.runsOutHour, 3, "0.6 + 0.6 + 0.6 = 1.8; the fourth hour needs 0.6 with 0.2 left");
  assert.equal(o.shortfallKwh, 1.6);
  // (3.6 × 1.2 − 2) × 200 × 1.075 = 498.8 → the ₦1,000 floor
  assert.equal(o.suggestedAmount, 1000);
  assert.equal(o.rateAssumed, false);

  const plenty = unitsOutlook({ meter: { ...meter, unitsKwh: 50 }, samples: [], base, nowIso: NIGHT_AT, tariff: null });
  assert.equal(plenty.runsOutHour, null);
  assert.equal(plenty.suggestedAmount, null, "no top-up when the units cover the day");
  assert.equal(plenty.rateAssumed, true);

  const unknown = unitsOutlook({ meter: { number: METER, disco: "ikeja" }, samples: [], base, nowIso: NIGHT_AT, tariff: null });
  assert.equal(unknown.balanceKwh, null);
  assert.equal(unknown.runsOutHour, null);
  assert.equal(unknown.shortfallKwh, 3.6);
  assert.equal(unknown.suggestedAmount, roundTopUp(3.6 * 1.2 * 225 * 1.075));

  const empty = unitsOutlook({ meter: { ...meter, unitsKwh: 0 }, samples: [], base, nowIso: NIGHT_AT, tariff: null });
  assert.equal(empty.runsOutHour, 0, "an empty meter is out now, if the grid is needed now");

  const noGrid = forecast({ ...gridEvening(), gridForecast: Array(24).fill(false) });
  const off = unitsOutlook({ meter, samples: [], base: noGrid, nowIso: NIGHT_AT, tariff: null });
  assert.equal(off.needNext24hKwh, 0);
  assert.equal(off.runsOutHour, null);
  assert.equal(off.suggestedAmount, null);
});

test("forecastWithoutUnits: once the units are gone the battery carries the house", () => {
  const input = { ...gridEvening(), loadForecastW: Array(24).fill(200) }; // light enough that neither run empties the battery
  const withUnits = forecast(input), without = forecastWithoutUnits(input, 3);
  assert.ok(without.minSocPct < withUnits.minSocPct);
  assert.deepEqual(without.points.slice(0, 3).map((p) => p.gridOn), [true, true, true]);
  assert.ok(without.points.slice(3).every((p) => !p.gridOn));
});

// ---------------------------------------------------------------- vendors

test("simulated vendor: deterministic token per reference, never vends twice, refuses an unknown meter", async () => {
  const v = new SimulatedVendor();
  const ref = "202610012100plabc123";
  const a = await v.buy({ ref, meter: METER, disco: "ikeja", amount: 5000 });
  const b = await v.buy({ ref, meter: METER, disco: "ikeja", amount: 9000 });
  assert.equal(a.status, "delivered");
  assert.match(a.token!, /^\d{20}$/);
  assert.deepEqual(b, a, "same reference, same vend");
  assert.equal(a.units, unitsFor(5000, 225));
  assert.equal((await v.requery(ref)).token, a.token);
  assert.equal((await v.verify("0000123456789", "ikeja")).ok, false);
  assert.equal((await v.verify(METER, "atlantis")).ok, false);
  assert.equal((await v.buy({ ref: "202610012100plzzz", meter: "0000123456789", disco: "ikeja", amount: 1000 })).status, "failed");
});

/** A fake fetch that answers like VTpass's sandbox and records what it was sent. */
function fakeVtpass(answers: Record<string, unknown | ((body: Record<string, unknown>) => unknown)>) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const f = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ url, headers: init.headers, body });
    const key = Object.keys(answers).find((k) => url.endsWith(k));
    const a = key ? answers[key] : undefined;
    if (a instanceof Error) throw a;
    const json = typeof a === "function" ? (a as (b: Record<string, unknown>) => unknown)(body) : a;
    return { ok: true, status: 200, text: async () => (typeof json === "string" ? json : JSON.stringify(json ?? { code: "012", response_description: "PRODUCT DOES NOT EXIST" })) };
  };
  return { f, sent };
}

const VERIFY_OK = { code: "000", content: { Customer_Name: "TESTMETER1", Address: "ABULE - EGBA BU ABULE", Meter_Type: "PREPAID", Min_Purchase_Amount: 500, WrongBillersCode: false } };
const PAY_OK = { code: "000", content: { transactions: { status: "delivered", transactionId: "17416390476218789963" } }, response_description: "TRANSACTION SUCCESSFUL", requestId: "x", amount: 5000, purchased_code: "Token : 4250 7149 5310 5432 7853", token: "42507149531054327853", units: "20.70 kWh" };

test("VTpass: verify and pay are POSTs to the sandbox with api-key and secret-key", async () => {
  const { f, sent } = fakeVtpass({ "/merchant-verify": VERIFY_OK, "/pay": PAY_OK });
  const v = new VtpassVendor({ apiKey: "ak", secretKey: "SK_x", fetch: f });
  assert.equal(v.name, "vtpass-sandbox");
  const check = await v.verify(METER, "ikeja");
  assert.deepEqual(check, { ok: true, customerName: "TESTMETER1", address: "ABULE - EGBA BU ABULE", minAmount: 500 });
  const vend = await v.buy({ ref: "202610012100plabc", meter: METER, disco: "ikeja", amount: 5000 });
  assert.equal(vend.status, "delivered");
  assert.equal(vend.token, "42507149531054327853");
  assert.equal(vend.units, 20.7);
  assert.equal(vend.vendorRef, "17416390476218789963");
  assert.equal(sent[0].url, `${VTPASS_SANDBOX}/merchant-verify`);
  assert.deepEqual(sent[0].body, { billersCode: METER, serviceID: "ikeja-electric", type: "prepaid" });
  assert.equal(sent[1].url, `${VTPASS_SANDBOX}/pay`);
  assert.deepEqual({ ...sent[1].body, phone: undefined }, { request_id: "202610012100plabc", serviceID: "ikeja-electric", billersCode: METER, variation_code: "prepaid", amount: 5000, phone: undefined });
  for (const s of sent) { assert.equal(s.headers["api-key"], "ak"); assert.equal(s.headers["secret-key"], "SK_x"); }
});

test("VTpass: the token is the first 20-digit group, never digits glued from other numbers; tokenAmount is not kWh", async () => {
  assert.equal(VtpassVendor.tokenOf("Token : 26362054405982757802 : 11.4kWh"), "26362054405982757802");
  assert.equal(VtpassVendor.tokenOf("Token : 4250 7149 5310 5432 7853"), "42507149531054327853");
  assert.equal(VtpassVendor.tokenOf("26362054405982757802 11"), "26362054405982757802");
  assert.equal(VtpassVendor.tokenOf("1234 5678"), undefined);
  assert.equal(VtpassVendor.tokenOf(42507149531054327853), undefined, "a JSON number has already lost digits");
  const v = new VtpassVendor({ apiKey: "a", secretKey: "s", fetch: fakeVtpass({ "/pay": { code: "000", content: { transactions: { status: "delivered" } }, purchased_code: "Token : 26362054405982757802 : 11.4kWh", tokenAmount: 4651.16 } }).f });
  const r = await v.buy({ ref: "202610012100plt", meter: METER, disco: "ikeja", amount: 5000 });
  assert.equal(r.token, "26362054405982757802");
  assert.equal(r.units, undefined, "4651.16 naira must not become 4,651 kWh");
  const m = new VtpassVendor({ apiKey: "a", secretKey: "s", fetch: fakeVtpass({ "/pay": { ...PAY_OK, units: undefined, mainTokenUnits: "11.4" } }).f });
  assert.equal((await m.buy({ ref: "202610012100plu", meter: METER, disco: "ikeja", amount: 5000 })).units, 11.4);
});

test("VTpass: a wrong meter, a failed pay, a processing pay and a dropped connection", async () => {
  const wrong = new VtpassVendor({ apiKey: "a", secretKey: "s", fetch: fakeVtpass({ "/merchant-verify": { code: "000", content: { WrongBillersCode: true, error: "This meter is not correct or is not a valid Ikeja Electric prepaid meter." } } }).f });
  const c = await wrong.verify("1234567890123", "ikeja");
  assert.equal(c.ok, false);
  assert.match(c.error!, /not correct/);

  const failed = new VtpassVendor({ apiKey: "a", secretKey: "s", fetch: fakeVtpass({ "/pay": { code: "016", response_description: "TRANSACTION FAILED", content: { transactions: { status: "failed" } } } }).f });
  assert.deepEqual(await failed.buy({ ref: "202610012100plx", meter: METER, disco: "ikeja", amount: 1000 }), { status: "failed", message: "TRANSACTION FAILED", vendorRef: undefined });

  const processing = new VtpassVendor({ apiKey: "a", secretKey: "s", fetch: fakeVtpass({ "/pay": { code: "099", response_description: "TRANSACTION IS PROCESSING" }, "/requery": PAY_OK }).f });
  assert.equal((await processing.buy({ ref: "202610012100ply", meter: METER, disco: "ikeja", amount: 1000 })).status, "pending");
  assert.equal((await processing.requery("202610012100ply")).status, "delivered");

  const dropped = new VtpassVendor({ apiKey: "a", secretKey: "s", fetch: fakeVtpass({ "/pay": new Error("socket hang up") }).f });
  const d = await dropped.buy({ ref: "202610012100plz", meter: METER, disco: "ikeja", amount: 1000 });
  assert.equal(d.status, "pending", "an unclear answer must be asked about again, never bought again");

  const html = new VtpassVendor({ apiKey: "a", secretKey: "s", fetch: fakeVtpass({ "/merchant-verify": "<html>maintenance</html>" }).f });
  await assert.rejects(html.verify(METER, "ikeja"), /not JSON/);
});

test("vendorFromEnv: simulated by default; VTpass only with keys; never a live endpoint by accident", () => {
  const quiet = console.error; console.error = () => {};
  try {
    assert.equal(vendorFromEnv({}).name, "simulated");
    assert.equal(vendorFromEnv({ UNITS_VENDOR: "vtpass" }).name, "simulated", "no keys");
    assert.equal(vendorFromEnv({ UNITS_VENDOR: "vtpass", VTPASS_API_KEY: "a", VTPASS_SECRET_KEY: "s" }).name, "vtpass-sandbox");
    assert.equal(vendorFromEnv({ UNITS_VENDOR: "vtpass", VTPASS_API_KEY: "a", VTPASS_SECRET_KEY: "s", VTPASS_BASE_URL: "https://vtpass.com/api" }).name, "simulated", "live refused without VTPASS_ALLOW_LIVE");
    assert.equal(vendorFromEnv({ UNITS_VENDOR: "vtpass", VTPASS_API_KEY: "a", VTPASS_SECRET_KEY: "s", VTPASS_BASE_URL: "https://vtpass.com/api", VTPASS_ALLOW_LIVE: "1" }).name, "vtpass-live");
    assert.equal(vendorFromEnv({ UNITS_VENDOR: "paypal" }).name, "simulated");
  } finally { console.error = quiet; }
});

test("sanitize keeps a good meter and purchases, drops broken ones", () => {
  const h = { ...emptyHousehold(),
    meter: { number: METER, disco: "ikeja", customerName: "X", unitsKwh: 12.345, unitsAt: NIGHT_AT },
    purchases: [
      { ref: "202610012100plok", at: NIGHT_AT, amount: 5000, meter: METER, vendor: "simulated", status: "delivered", token: "4250-7149-5310-5432-7853", units: 20.7 },
      { ref: "short", at: NIGHT_AT, amount: 5000, meter: METER, vendor: "simulated", status: "delivered" },
      { ref: "202610012100plneg", at: NIGHT_AT, amount: -1, meter: METER, vendor: "simulated", status: "delivered" },
      { ref: "202610012100plbad", at: NIGHT_AT, amount: 100, meter: METER, vendor: "simulated", status: "refunded" },
    ] } as never;
  const s = sanitize(h);
  assert.deepEqual(s.meter, { number: METER, disco: "ikeja", customerName: "X", unitsKwh: 12.3, unitsAt: NIGHT_AT });
  assert.equal(s.purchases!.length, 1);
  assert.equal(s.purchases![0].token, "42507149531054327853");
  assert.equal(sanitize({ ...emptyHousehold(), meter: { number: "12", disco: "ikeja" } } as never).meter, null);
  assert.deepEqual(sanitize({ ...emptyHousehold(), meter: { number: METER, disco: "ikeja", unitsKwh: Number.NaN, unitsAt: NIGHT_AT } } as never).meter, { number: METER, disco: "ikeja" });
  assert.deepEqual(sanitize({ ...emptyHousehold(), purchases: "lots" } as never).purchases, []);
});

// ---------------------------------------------------------------- tools over MCP

const night = (grid = true): TelemetrySource => ({
  name: "fake",
  current: async () => ({ at: NIGHT_AT, pv_w: 0, load_w: 600, battery_w: 0, soc_pct: 60, grid_w: 600, grid_available: grid, source: "fake" }),
});

type Answer = boolean | "decline" | "garbage" | "hang";
async function connect(userId: string, opts: { vendor?: UnitsVendor; elicit?: Answer } = {}) {
  setStore(new DiskStore(mkdtempSync(path.join(tmpdir(), "pl-units-"))));
  const server = createServer({ userId, source: night() }, { vendor: opts.vendor ?? new SimulatedVendor() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" }, opts.elicit !== undefined ? { capabilities: { elicitation: {} } } : {});
  const asked: string[] = [];
  if (opts.elicit !== undefined) {
    client.setRequestHandler("elicitation/create", async (req: { params?: { message: string } }) => {
      asked.push(req.params?.message ?? "");
      if (opts.elicit === "decline") return { action: "decline" };
      if (opts.elicit === "garbage") return { action: "accept", content: { confirm: "yes please" } };
      if (opts.elicit === "hang") return new Promise(() => {});
      return { action: "accept", content: { confirm: opts.elicit } };
    });
  }
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { ...r, text: r.content.find((c) => c.type === "text")?.text ?? "" };
  };
  const close = async () => { await client.close(); await server.close(); setStore(null); };
  return { call, close, asked, client };
}

/** Grid on all evening, the house on it: the next 24 h need grid energy, so there is something to run out of. */
async function withGridPattern(userId: string) {
  await updateHousehold(userId, (h) => {
    // Grid on 18:00–06:00 Lagos every day for the last week, so the learned pattern says "on" tonight.
    for (let d = 7; d >= 1; d--) {
      const day = Date.parse("2026-10-01T00:00:00Z") - d * 86_400_000;
      h.gridEvents.push({ at: new Date(day + 17 * 3_600_000).toISOString(), on: true }, { at: new Date(day + 29 * 3_600_000).toISOString(), on: false });
    }
  });
}

test("set_meter verifies before saving; a wrong number or unknown DisCo saves nothing", async () => {
  const { call, close } = await connect("m1");
  const bad = await call("set_meter", { meterNumber: "12345", disco: "Ikeja Electric" });
  assert.equal(bad.isError, true);
  const who = await call("set_meter", { meterNumber: METER, disco: "Lagos Gas" });
  assert.equal(who.isError, true);
  assert.match(who.text, /Ikeja Electric/);
  const missing = await call("set_meter", { meterNumber: "0000123456789", disco: "IKEDC" });
  assert.equal(missing.isError, true);
  assert.equal((await getHousehold("m1")).meter, null);
  const units = await call("set_meter", { unitsLeft: 40 });
  assert.equal(units.isError, true, "a balance needs a meter");

  const ok = await call("set_meter", { meterNumber: "1111 1111 1111 1", disco: "IKEDC", unitsLeft: 40 });
  assert.equal(ok.isError, undefined);
  assert.match(ok.text, /…1111 verified with Ikeja Electric: Simulated customer\. Balance 40 kWh\..*Simulated vendor/);
  assert.equal(ok.text.includes(METER), false, "the full meter number is not read back");
  assert.deepEqual((await getHousehold("m1")).meter, { number: METER, disco: "ikeja", customerName: "Simulated customer", minAmount: 500, unitsKwh: 40, unitsAt: NIGHT_AT });
  const later = await call("set_meter", { unitsLeft: 12.5 });
  assert.match(later.text, /12\.5 kWh/);
  const same = await call("set_meter", { disco: "Ikeja Electric" });
  assert.equal((await getHousehold("m1")).meter?.unitsKwh, 12.5, "re-verifying the same meter keeps the balance");
  assert.equal(same.isError, undefined);
  await close();
});

test("prepaid_units: no meter, unknown balance, and units that run out tonight", async () => {
  const { call, close } = await connect("m2");
  await withGridPattern("m2");
  assert.match((await call("prepaid_units")).text, /don't have your prepaid meter/);
  await call("set_meter", { meterNumber: METER, disco: "Ikeja" });
  const unknown = await call("prepaid_units");
  assert.match(unknown.text, /don't know the meter's balance/);
  assert.equal(unknown.structuredContent?.balanceKwh, null);
  await call("set_meter", { unitsLeft: 1 });
  const low = await call("prepaid_units");
  assert.match(low.text, /About 1 kWh left/);
  assert.match(low.text, /run out around \d\d:00 while the grid is on; after that the battery carries the house/);
  assert.match(low.text, /top-up of ₦[\d,]+ covers the next day/);
  assert.ok((low.structuredContent?.suggestedAmount as number) >= 1000);
  assert.ok(low.structuredContent?.afterRunout);
  await close();
});

test("buy_units with elicitation: asks first, buys on yes, records it, pushes the token, updates the balance", async () => {
  const { call, close, asked, client } = await connect("m3", { elicit: true });
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 3 });
  const r = await call("buy_units", { amount: 5000 });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Buy ₦5,000 of electricity for meter …1111 \(Ikeja Electric, Simulated customer\)\? That is about 20\.7 kWh at ₦225\/kWh \(assumed\), including 7\.5% VAT\. \(Simulated vendor/);
  assert.equal(r.structuredContent?.bought, true);
  assert.match(r.text, /Bought ₦5,000 of units for meter …1111: 20\.7 kWh\. Token: \d{4}-\d{4}-\d{4}-\d{4}-\d{4}/);
  const h = await getHousehold("m3");
  assert.equal(h.purchases!.length, 1);
  assert.equal(h.purchases![0].status, "delivered");
  assert.match(h.purchases![0].ref, /^\d{12}pl/);
  assert.equal(h.meter?.unitsKwh, 23.7);
  // The alerts resource carries the token too (the toast in the host).
  const res = await client.readResource({ uri: "powerline://alerts" });
  const { alerts } = JSON.parse((res.contents[0] as { text: string }).text) as { alerts: Array<{ kind: string; text: string }> };
  assert.ok(alerts.some((x) => x.kind === "purchase" && /Token for meter …1111: \d{4}-/.test(x.text)), JSON.stringify(alerts));
  await close();
});

test("buy_units never buys on no, on an unreadable answer, over a limit, or without a meter", async () => {
  {
    const { call, close } = await connect("n1", { elicit: true });
    assert.equal((await call("buy_units", { amount: 5000 })).structuredContent?.reason, "no-meter");
    await close();
  }
  for (const answer of [false, "decline", "garbage"] as const) {
    const { call, close } = await connect(`n2-${answer}`, { elicit: answer });
    await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 3 });
    const r = await call("buy_units", { amount: 5000 });
    assert.equal(r.structuredContent?.bought, false, String(answer));
    assert.deepEqual((await getHousehold(`n2-${answer}`)).purchases, [], String(answer));
    await close();
  }
  {
    const { call, close, asked } = await connect("n3", { elicit: true });
    await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 3 });
    const big = await call("buy_units", { amount: 25_000 });
    assert.equal(big.structuredContent?.reason, "over-limit");
    const small = await call("buy_units", { amount: 100 });
    assert.equal(small.isError, true, "under the ₦500 minimum is refused by the schema");
    const frac = await call("buy_units", { amount: 1000.5 });
    assert.equal(frac.isError, true);
    // Daily limit: ₦50,000 in 24 h at ₦20,000 a time → the third is refused.
    assert.equal((await call("buy_units", { amount: 20_000 })).structuredContent?.bought, true);
    assert.equal((await call("buy_units", { amount: 20_000 })).structuredContent?.bought, true);
    const third = await call("buy_units", { amount: 20_000 });
    assert.equal(third.structuredContent?.reason, "daily-limit");
    assert.equal(asked.length, 2, "a refused purchase is refused before the question");
    await close();
  }
});

test("buy_units without elicitation: a quote first, the purchase only when that quote is confirmed, once", async () => {
  const { call, close } = await connect("q1");
  await call("set_meter", { meterNumber: METER, disco: "Eko", unitsLeft: 3 });
  const quote = await call("buy_units", { amount: 3000 });
  assert.equal(quote.structuredContent?.needsConfirmation, true);
  assert.match(quote.text, /Buy ₦3,000 .* Say “yes” to confirm \(quote q[0-9a-f]{6}/);
  assert.deepEqual((await getHousehold("q1")).purchases, [], "a quote buys nothing");
  const id = quote.structuredContent?.quoteId as string;
  const forged = await call("buy_units", { quoteId: "qffffff" });
  assert.equal(forged.structuredContent?.reason, "quote-expired");
  const done = await call("buy_units", { quoteId: id, amount: 19_000 });
  assert.equal(done.structuredContent?.bought, true);
  assert.equal(done.structuredContent?.amount, 3000, "the quoted amount, not whatever the second call says");
  const again = await call("buy_units", { quoteId: id });
  assert.equal(again.structuredContent?.reason, "quote-expired", "a quote is spent once");
  assert.equal((await getHousehold("q1")).purchases!.length, 1);
  await close();
});

test("buy_units: a pending vend blocks a second purchase and settles on the next look", async () => {
  let state: Vend["status"] = "pending";
  const sim = new SimulatedVendor();
  const flaky: UnitsVendor = {
    name: "flaky", simulated: true,
    verify: (m, d) => sim.verify(m, d),
    buy: async () => ({ status: "pending", message: "processing" }),
    requery: async () => (state === "pending" ? { status: "pending" } : { status: "delivered", token: "12345678901234567890", units: 10 }),
  };
  const { call, close } = await connect("p1", { vendor: flaky, elicit: true });
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 2 });
  const first = await call("buy_units", { amount: 2000 });
  assert.equal(first.structuredContent?.reason, "pending");
  const second = await call("buy_units", { amount: 2000 });
  assert.equal(second.structuredContent?.reason, "pending");
  assert.match(second.text, /still processing/);
  assert.equal((await getHousehold("p1")).purchases!.length, 1, "never bought twice");
  // A requery never overtakes a purchase that is still landing: too young to ask about yet.
  state = "delivered";
  assert.match((await call("prepaid_units")).text, /still processing/);
  await updateHousehold("p1", (h) => { h.purchases![0].at = new Date(Date.now() - 120_000).toISOString(); });
  const look = await call("prepaid_units");
  assert.doesNotMatch(look.text, /still processing/);
  assert.match(look.text, /^Your earlier ₦2,000 purchase went through\. Token: 1234-5678-9012-3456-7890 \(10 kWh\)\./, "the late token is told, once");
  assert.doesNotMatch((await call("prepaid_units")).text, /went through/);
  const h = await getHousehold("p1");
  assert.equal(h.purchases![0].status, "delivered");
  assert.equal(h.purchases![0].token, "12345678901234567890");
  assert.equal(h.meter?.unitsKwh, 12);
  await close();
});

test("buy_units: a failed vend says so, issues no token, and does not count against the daily limit", async () => {
  const sim = new SimulatedVendor();
  const declining: UnitsVendor = { name: "declining", simulated: true, verify: (m, d) => sim.verify(m, d), buy: async () => ({ status: "failed", message: "INSUFFICIENT WALLET BALANCE" }), requery: async () => ({ status: "failed" }) };
  const { call, close } = await connect("f1", { vendor: declining, elicit: true });
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 2 });
  const r = await call("buy_units", { amount: 20_000 });
  assert.match(r.text, /failed: INSUFFICIENT WALLET BALANCE\. No token was issued/);
  for (let i = 0; i < 3; i++) await call("buy_units", { amount: 20_000 });
  assert.equal((await getHousehold("f1")).purchases!.filter((p) => p.status === "failed").length, 4);
  assert.equal((await getHousehold("f1")).meter?.unitsKwh, 2);
  await close();
});

test("buy_units with no amount buys the suggested top-up, or says none is needed", async () => {
  const { call, close, asked } = await connect("s1", { elicit: true });
  await withGridPattern("s1");
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 500 });
  const none = await call("buy_units");
  assert.equal(none.structuredContent?.reason, "not-needed");
  assert.equal(asked.length, 0);
  await call("set_meter", { unitsLeft: 0.5 });
  const r = await call("buy_units");
  assert.equal(r.structuredContent?.bought, true);
  assert.ok((r.structuredContent?.amount as number) >= 1000 && (r.structuredContent?.amount as number) % 500 === 0);
  await close();
});

test("evening_briefing mentions the units only when they run out", async () => {
  const { call, close } = await connect("b1");
  await withGridPattern("b1");
  const before = await call("evening_briefing");
  assert.doesNotMatch(before.text, /units/i);
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 0.5 });
  const after = await call("evening_briefing");
  assert.match(after.text, /Prepaid units run out around \d\d:00; a top-up of ₦[\d,]+ covers tomorrow\./);
  await close();
});

test("a requery cannot fail a purchase whose vendor call is still running, and the vendor's answer is what counts", async () => {
  const sim = new SimulatedVendor();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: UnitsVendor = {
    name: "slow", simulated: true, verify: (m, d) => sim.verify(m, d),
    buy: async (req) => { await gate; return sim.buy(req); },
    requery: async () => ({ status: "failed", message: "INVALID REQUEST ID" }), // what VTpass says before the pay has landed
  };
  const { call, close } = await connect("r1", { vendor: slow, elicit: true });
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 5 });
  const buying = call("buy_units", { amount: 5000 });
  await new Promise((r) => setTimeout(r, 100));
  await updateHousehold("r1", (h) => { if (h.purchases?.[0]) h.purchases[0].at = new Date(Date.now() - 20 * 60_000).toISOString(); }); // even an "old" one: it is in flight here
  const look = await call("prepaid_units");
  assert.match(look.text, /still processing/);
  const again = await call("buy_units", { amount: 5000 });
  assert.equal(again.structuredContent?.reason, "pending", "no second purchase while the first is in flight");
  release();
  const r = await buying;
  assert.equal(r.structuredContent?.bought, true);
  const h = await getHousehold("r1");
  assert.deepEqual(h.purchases!.map((p) => p.status), ["delivered"]);
  assert.match(h.purchases![0].token!, /^\d{20}$/);
  assert.equal(h.meter?.unitsKwh, 25.7);
  await close();
});

test("the 24-hour ceiling counts every purchase of the day, however many there are", () => {
  const now = Date.now();
  const purchases = Array.from({ length: 80 }, (_, i) => ({ ref: `20261001210${String(i).padStart(2, "0")}plcap`, at: new Date(now - i * 60_000).toISOString(), amount: 999, meter: METER, vendor: "simulated", status: "delivered" as const }));
  const old = Array.from({ length: 70 }, (_, i) => ({ ref: `20260901210${String(i).padStart(2, "0")}plold`, at: new Date(now - 3 * 86_400_000 - i * 60_000).toISOString(), amount: 999, meter: METER, vendor: "simulated", status: "delivered" as const }));
  const s = sanitize({ ...emptyHousehold(), purchases: [...old, ...purchases] } as never);
  const dayAgo = now - 86_400_000;
  assert.equal(s.purchases!.filter((p) => Date.parse(p.at) > dayAgo).reduce((a, p) => a + p.amount, 0), 80 * 999);
  assert.equal(s.purchases!.length, 80 + 50, "older history is trimmed, today's never is");
});

test("set_meter keeps the DisCo's minimum and the balance when only the DisCo is corrected; buy_units respects the minimum", async () => {
  const sim = new SimulatedVendor();
  const strict: UnitsVendor = { ...sim, name: "strict", simulated: true, verify: async (m, d) => ({ ...(await sim.verify(m, d)), minAmount: 1000 }), buy: (r) => sim.buy(r), requery: (r) => sim.requery(r) };
  const { call, close } = await connect("mn1", { vendor: strict, elicit: true });
  await call("set_meter", { meterNumber: METER, disco: "Eko", unitsLeft: 7 });
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric" });
  const h = await getHousehold("mn1");
  assert.equal(h.meter?.disco, "ikeja");
  assert.equal(h.meter?.unitsKwh, 7);
  assert.equal(h.meter?.minAmount, 1000);
  const r = await call("buy_units", { amount: 500 });
  assert.equal(r.structuredContent?.reason, "under-minimum");
  assert.match(r.text, /minimum purchase for Ikeja Electric is ₦1,000/);
  await close();
});

test("a storage failure after the vend still hands over the token", async () => {
  const { call, close } = await connect("sf1", { elicit: true });
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 1 });
  const store = (await import("../src/store/index.js")).getStore();
  const real = store.update.bind(store);
  let n = 0;
  store.update = (async (id: string, m: (h: never) => void) => { n++; if (n === 2) throw new Error("disk full"); return real(id, m as never); }) as typeof store.update;
  const quiet = console.error; console.error = () => {};
  try {
    const r = await call("buy_units", { amount: 2000 });
    assert.equal(r.structuredContent?.bought, true);
    assert.equal(r.structuredContent?.saved, false);
    assert.match(r.text, /Token: \d{4}-\d{4}-\d{4}-\d{4}-\d{4}.*write the token down/);
  } finally { console.error = quiet; store.update = real; }
  await close();
});

test("a late delivery with no units figure is credited from the estimate, and an unknown prior balance is reported as a floor", async () => {
  const sim = new SimulatedVendor();
  const late: UnitsVendor = { name: "late", simulated: true, verify: (m, d) => sim.verify(m, d), buy: async () => ({ status: "pending", message: "TRANSACTION IS PROCESSING" }), requery: async () => ({ status: "delivered", token: "12345678901234567890" }) };
  const { call, close } = await connect("lt1", { vendor: late, elicit: true });
  await call("set_meter", { meterNumber: METER, disco: "Ikeja Electric", unitsLeft: 10 });
  await call("buy_units", { amount: 2000 });
  await updateHousehold("lt1", (h) => { h.purchases![0].at = new Date(Date.now() - 120_000).toISOString(); });
  const look = await call("prepaid_units");
  assert.match(look.text, /went through\. Token: 1234-5678-9012-3456-7890 \(8\.3 kWh\)/);
  const h = await getHousehold("lt1");
  assert.equal(h.meter?.unitsKwh, 18.3);
  assert.equal(h.purchases![0].message, undefined, "'processing' no longer describes a delivered purchase");

  const { call: call2, close: close2 } = await connect("lt2", { elicit: true });
  await call2("set_meter", { meterNumber: METER, disco: "Ikeja Electric" });
  const bought = await call2("buy_units", { amount: 2000 });
  assert.match(bought.text, /Balance now at least 8\.3 kWh/);
  assert.match((await call2("prepaid_units")).text, /^At least 8\.3 kWh left/);
  await call2("set_meter", { unitsLeft: 12 });
  assert.match((await call2("prepaid_units")).text, /^About 12 kWh left/, "a fresh reading is exact again");
  await close2();
  await close();
});

test("tariffs stored as 'naira' or '₦' before currencies were normalised still count as naira", () => {
  const base = forecast(gridEvening());
  for (const currency of ["naira", "₦", "ngn", "NGN"]) {
    const o = unitsOutlook({ meter: { number: METER, disco: "ikeja", unitsKwh: 1, unitsAt: NIGHT_AT }, samples: [], base, nowIso: NIGHT_AT, tariff: { currency, perKwh: 200 } });
    assert.equal(o.rateAssumed, false, currency);
    assert.equal(o.tariffCurrency, null, currency);
  }
  assert.equal(sanitize({ ...emptyHousehold(), tariff: { currency: "naira", perKwh: 200 } } as never).tariff?.currency, "NGN");
  assert.equal(unitsOutlook({ meter: null, samples: [], base, nowIso: NIGHT_AT, tariff: { currency: "usd", perKwh: 0.2 } }).tariffCurrency, "USD");
});
