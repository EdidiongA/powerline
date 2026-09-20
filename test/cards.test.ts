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

const STUB = `class App { constructor(){} connect(){ return Promise.resolve(); } callServerTool(){ return Promise.resolve({ structuredContent: undefined }); } }`;

/**
 * Transpile a view with esbuild's API (not a subprocess — `npx` is `npx.cmd` on
 * Windows and cannot be spawned by name), swap the SDK import for a stub, and run
 * the result in jsdom.
 */
function mount(page: "card" | "planner") {
  const out = buildSync({
    entryPoints: [path.resolve(`src/ui/${page}.ts`)],
    bundle: false, write: false, format: "esm", target: "es2022", logLevel: "silent",
  });
  const js = out.outputFiles[0].text.replace(/^import \{ App \}.*$/m, STUB);
  const html = readFileSync(path.resolve(`dist/ui/${page}.html`), "utf8").replace(/<script type="module">[\s\S]*?<\/script>/, "");
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
    { structuredContent: { ...plan, all: [{ name: "<img src=x onerror=alert(1)>", watts: 10, minutes: 5 }], items: [], selected: [] } },
    { structuredContent: { ...status, telemetry: { ...telemetry, at: "not-a-date", soc_pct: Number.NaN } } },
  ];
  for (const page of ["card", "planner"] as const) {
    const w = mount(page);
    for (const payload of nasty) {
      assert.doesNotThrow(() => w.__onresult(payload), `${page} threw on ${JSON.stringify(payload).slice(0, 60)}`);
      assert.ok((w.document.getElementById("root")?.innerHTML ?? "").length > 0, `${page} rendered nothing`);
    }
    assert.doesNotMatch(w.document.body.innerHTML, /onerror=/, `${page} did not escape appliance names`);
  }
});
