/**
 * Card render tests.
 *
 * The MCP App views are plain DOM modules, so they can be exercised in jsdom with a
 * stubbed App. These guard the failure mode that matters most in a demo: a card that
 * throws renders as a blank box in the host, with no error anywhere the user can see.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const STUB = `class App { constructor(){} connect(){ return Promise.resolve(); } getHostContext(){ return { theme: "dark" }; } callServerTool(){ return Promise.resolve({ structuredContent: undefined }); } }`;

/**
 * Transpile a view with esbuild's API (not a subprocess — `npx` is `npx.cmd` on
 * Windows and cannot be spawned by name), swap the SDK import for a stub, and run
 * the result in jsdom.
 */
function mount(page: "card" | "planner" | "report") {
  const out = buildSync({
    entryPoints: [path.resolve(`src/ui/${page}.ts`)],
    bundle: false, write: false, format: "esm", target: "es2022", logLevel: "silent",
  });
  const js = out.outputFiles[0].text.replace(/^import \{ App \}.*$/m, STUB);
  const html = readFileSync(path.resolve(`dist/ui/${page}.html`), "utf8").replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(js.replace(/app\.ontoolresult = /, "window.__onresult = "));
  return dom.window as unknown as Window & { __onresult: (r: unknown) => void; document: Document };
}

const telemetry = { at: "2026-09-15T18:30:00.000Z", pv_w: 0, load_w: 420, battery_w: -420, soc_pct: 64, grid_w: 0, grid_available: false, source: "simulated" };
const forecast = Array.from({ length: 24 }, (_, h) => ({ hour: h, socPct: Math.max(0, 64 - h * 2), pvW: h > 12 && h < 20 ? 2000 : 0, loadW: 420, gridOn: h % 7 === 0, batteryW: -420 }));
const status = { telemetry, profile: { reserveSocPct: 20, batteryKwh: 10 }, forecast, hoursToFloor: 22, minSocPct: 18 };

const plan = {
  items: [{ name: "iron", watts: 2000, minutes: 30, startHour: 14, onSurplus: true, source: "solar" as const, reason: "runs on solar surplus" }],
  minSocPct: 51.2, hitsFloor: false,
  all: [{ name: "iron", watts: 2000, minutes: 30 }, { name: "washing machine", watts: 500, minutes: 45 }],
  selected: ["iron"], localHour: 13, socNow: 81.8, reserve: 20,
};

test("dashboard renders a healthy reading", () => {
  const w = mount("card");
  w.__onresult({ structuredContent: { ...status, hoursToFloor: null, minSocPct: 55 } });
  const text = w.document.body.textContent ?? "";
  assert.match(text, /55%/);
  assert.match(text, /Holds/);
  assert.match(text, /drawing 420 W/, "battery draw is shown without a sign");
  assert.equal(w.document.querySelectorAll("svg").length, 1);
});

test("dashboard warns when the reserve will be reached", () => {
  const w = mount("card");
  w.__onresult({ structuredContent: status });
  assert.match(w.document.body.textContent ?? "", /Reaches reserve/);
});

test("dashboard states the case when already below reserve", () => {
  const w = mount("card");
  w.__onresult({ structuredContent: { ...status, telemetry: { ...telemetry, soc_pct: 12 }, hoursToFloor: 0, minSocPct: 5 } });
  assert.match(w.document.body.textContent ?? "", /Below your 20% reserve/);
});

test("planner renders rows, slots and honours the unticked state", () => {
  const w = mount("planner");
  w.__onresult({ structuredContent: plan });
  assert.equal(w.document.querySelectorAll(".row").length, 2);
  assert.equal(w.document.querySelectorAll(".slot").length, 1);
  const boxes = [...w.document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
  assert.equal(boxes.filter((b) => b.checked).length, 1);
});

test("planner invites the user to add appliances when there are none", () => {
  const w = mount("planner");
  w.__onresult({ structuredContent: { items: [], all: [], selected: [], localHour: 9, minSocPct: 80, hitsFloor: false, socNow: 80, reserve: 20 } });
  assert.match(w.document.body.textContent ?? "", /remember the washing machine/i);
});

test("neither card throws on absent, partial or hostile payloads", () => {
  const nasty: unknown[] = [
    {},
    { structuredContent: undefined },
    { structuredContent: {} },
    { structuredContent: { telemetry, profile: { reserveSocPct: 20 }, forecast: [] } },
    { structuredContent: { items: null, all: null, selected: null } },
    { structuredContent: { ...plan, all: [{ name: "<img src=x onerror=alert(1)>", watts: 10, minutes: 5 }, { name: "x\" onmouseover=\"alert(2)", watts: 10, minutes: 5 }], items: [], selected: [] } },
    { structuredContent: { ...status, telemetry: { ...telemetry, at: "not-a-date", soc_pct: Number.NaN } } },
  ];
  for (const page of ["card", "planner"] as const) {
    const w = mount(page);
    for (const payload of nasty) {
      assert.doesNotThrow(() => w.__onresult(payload), `${page} threw on ${JSON.stringify(payload).slice(0, 60)}`);
      assert.ok((w.document.getElementById("root")?.innerHTML ?? "").length > 0, `${page} rendered nothing`);
    }
    assert.equal(w.document.querySelector("img, [onerror], [onmouseover]"), null, `${page} let markup or an attribute through from an appliance name`);
  }
});

test("planner shows an Arm control and reflects armed state", () => {
  const w = mount("planner");
  w.__onresult({ structuredContent: plan });
  const btn = w.document.querySelector<HTMLButtonElement>("#arm")!;
  assert.ok(btn && !btn.disabled);
  assert.match(btn.textContent ?? "", /Arm plan/);
  w.__onresult({ structuredContent: { ...plan, armed: ["iron"] } });
  assert.match(w.document.querySelector("#arm")?.textContent ?? "", /Armed/);
  w.__onresult({ structuredContent: { ...plan, items: [], all: [], selected: [] } });
  assert.equal(w.document.querySelector("#arm"), null);
});

test("dashboard: charging below reserve says so instead of 'cut loads'; idle battery; error and cancel states", () => {
  const w = mount("card");
  const rising = forecast.map((p, h) => ({ ...p, socPct: 22 + h * 4 })); // above reserve by the end of this hour
  w.__onresult({ structuredContent: { ...status, telemetry: { ...telemetry, soc_pct: 15, battery_w: 900, pv_w: 1300 }, forecast: rising, hoursToFloor: 0, minSocPct: 15 } });
  let text = w.document.body.textContent ?? "";
  assert.match(text, /Below your 20% reserve/);
  assert.match(text, /Charging — back above it within the hour/);
  assert.doesNotMatch(text, /Cut non-essential/);

  w.__onresult({ structuredContent: { ...status, telemetry: { ...telemetry, battery_w: 2, pv_w: 0, load_w: 0 }, hoursToFloor: null, minSocPct: 60 } });
  text = w.document.body.textContent ?? "";
  assert.match(text, /battery idle/);
  assert.match(text, /Nothing/i);

  w.__onresult({ isError: true, content: [{ type: "text", text: "VRM 429 Too Many Requests" }] });
  assert.match(w.document.body.textContent ?? "", /could not read the inverter: VRM 429/);
  assert.doesNotMatch(w.document.body.textContent ?? "", /NaN|undefined/);
});

test("dashboard footer names the default profile so the user knows to set up theirs", () => {
  const w = mount("card");
  w.__onresult({ structuredContent: { ...status, profileIsDefault: true } });
  assert.match(w.document.getElementById("src")?.textContent ?? "", /default profile/);
  w.__onresult({ structuredContent: { ...status, profileIsDefault: false } });
  assert.doesNotMatch(w.document.getElementById("src")?.textContent ?? "", /default profile/);
});

test("planner: nothing-selected state, re-arm offer when the armed plan differs, and error state", () => {
  const w = mount("planner");
  w.__onresult({ structuredContent: { ...plan, items: [], selected: [] } });
  let text = w.document.body.textContent ?? "";
  assert.match(text, /Nothing selected/);
  assert.equal(w.document.querySelectorAll(".row").length, 2, "rows stay so the user can tick one");
  assert.equal(w.document.querySelector<HTMLButtonElement>("#arm")?.disabled, true);

  w.__onresult({ structuredContent: { ...plan, armed: ["washing machine"] } });
  assert.match(w.document.querySelector("#arm")?.textContent ?? "", /Re-arm/);
  assert.match(w.document.getElementById("status")?.textContent ?? "", /differs/);

  w.__onresult({ isError: true, content: [{ type: "text", text: "store unavailable" }] });
  text = w.document.body.textContent ?? "";
  assert.match(text, /could not plan: store unavailable/);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("no NaN or undefined leaks into either card from an empty payload", () => {
  for (const page of ["card", "planner"] as const) {
    const w = mount(page);
    w.__onresult({ structuredContent: page === "card" ? { telemetry: {}, profile: {}, forecast: [{}, {}] } : { items: [{ name: "x" }], all: [{ name: "x" }], selected: ["x"] } });
    assert.doesNotMatch(w.document.body.textContent ?? "", /NaN|undefined/, `${page} leaked NaN/undefined`);
  }
});

test("cards follow the host's theme rather than only the OS setting", async () => {
  for (const page of ["card", "planner"] as const) {
    const w = mount(page);
    await new Promise((r) => setTimeout(r, 0)); // let connect() resolve
    assert.equal(w.document.documentElement.dataset.theme, "dark", `${page} did not apply the host theme`);
  }
});

const report = {
  period: "week", reserve: 20, empty: false,
  days: [{ date: "2026-10-01", hours: 24, solarKwh: 14.2, loadKwh: 11.1, gridHours: 5, gridKwh: 2.1, minSocPct: 31, hoursBelowReserve: 0, solarSharePct: 80 },
         { date: "2026-10-02", hours: 24, solarKwh: 9.8, loadKwh: 12.4, gridHours: 7, gridKwh: 3.4, minSocPct: 18, hoursBelowReserve: 2, solarSharePct: 60 }],
  summary: { solarKwh: 24, loadKwh: 23.5, gridKwh: 5.5, gridHours: 12, minSocPct: 18, hoursBelowReserve: 2, solarSharePct: 77, gridCost: 1237.5, solarValue: 4050, currency: "NGN" },
  learned: { loadProfile: true, pvFactor: 0.81, days: 7 },
};

test("report card renders totals, day bars, cost and the learning line; empty and hostile states", () => {
  const w = mount("report");
  w.__onresult({ structuredContent: report });
  const text = w.document.body.textContent ?? "";
  assert.match(text, /24kWh/);
  assert.match(text, /NGN 1,238/);
  assert.match(text, /2 h at or below the 20% reserve/);
  assert.match(text, /own pattern \(7 days, array at 81% of clear-sky\)/);
  assert.equal(w.document.querySelectorAll(".bar.sun").length, 2);
  assert.equal(w.document.querySelectorAll("button[data-period]").length, 3);
  // "7 days" always draws seven slots: days without readings are empty and dimmed, and the heading says how many have data.
  const week = { ...report, period: "week", dates: ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"] };
  w.__onresult({ structuredContent: week });
  assert.equal(w.document.querySelectorAll(".day").length, 7);
  assert.equal(w.document.querySelectorAll(".day.empty").length, 5);
  assert.match(w.document.body.textContent ?? "", /readings on 2 of 7/);
  w.__onresult({ structuredContent: { ...week, dates: "not-a-list" } });
  assert.equal(w.document.querySelectorAll(".day").length, 2, "a bad dates field falls back to the days that exist");

  w.__onresult({ structuredContent: { ...report, period: "today", days: [], empty: true, learned: { loadProfile: false, pvFactor: null, days: 1 } } });
  assert.match(w.document.body.textContent ?? "", /No readings for today yet/);
  assert.match(w.document.body.textContent ?? "", /1 of 3 days/);

  for (const bad of [{}, { structuredContent: {} }, { structuredContent: { period: "nope", days: null, summary: null } }, { structuredContent: { ...report, days: [{ date: "<img src=x onerror=alert(1)>" }] } }]) {
    assert.doesNotThrow(() => w.__onresult(bad));
    assert.doesNotMatch(w.document.body.textContent ?? "", /NaN|undefined/);
  }
  assert.equal(w.document.querySelector("img, [onerror]"), null, "a day label became markup");
  w.__onresult({ isError: true, content: [{ type: "text", text: "store unavailable" }] });
  assert.match(w.document.body.textContent ?? "", /could not build the report: store unavailable/);
});
