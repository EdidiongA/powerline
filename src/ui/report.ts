import { App } from "@modelcontextprotocol/ext-apps";

interface Day { date: string; hours: number; solarKwh: number; loadKwh: number; gridHours: number; gridKwh: number; minSocPct: number; hoursBelowReserve: number; solarSharePct: number }
interface Summary { solarKwh: number; loadKwh: number; gridKwh: number; gridHours: number; minSocPct: number; hoursBelowReserve: number; solarSharePct: number; gridCost: number | null; solarValue: number | null; currency: string | null }
interface Report { period: "today" | "yesterday" | "week"; dates?: string[]; days: Day[]; summary: Summary; learned?: { loadProfile: boolean; pvFactor: number | null; days: number }; reserve: number; empty?: boolean }

const root = document.getElementById("root")!;
const status = document.getElementById("status")!;
const VERSION = typeof __POWERLINE_VERSION__ === "string" ? __POWERLINE_VERSION__ : "dev";
const app = new App({ name: "powerline-report", version: VERSION }, {});
let busy = false;

const fin = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const esc = (s: string) => s.replace(/[<&>"']/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
const placeholder = (text: string) => { root.innerHTML = `<div class="placeholder">${esc(text)}</div>`; };
const kwh = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
const money = (v: number, cur: string) => `${esc(cur)} ${v >= 100 ? Math.round(v).toLocaleString("en") : v.toFixed(2)}`;
const dayLabel = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return Number.isNaN(t) ? d : new Date(t).toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }); };
const TITLE: Record<Report["period"], string> = { today: "Today", yesterday: "Yesterday", week: "Last 7 days" };
const TAB: Record<Report["period"], string> = { today: "Today", yesterday: "Yesterday", week: "7 days" };

function render(raw: Report) {
  const period = (["today", "yesterday", "week"] as const).includes(raw.period) ? raw.period : "week";
  const days = (Array.isArray(raw.days) ? raw.days : []).filter((d) => d && typeof d.date === "string").map((d) => ({ ...d, solarKwh: fin(d.solarKwh), loadKwh: fin(d.loadKwh), gridHours: fin(d.gridHours), gridKwh: fin(d.gridKwh), minSocPct: fin(d.minSocPct, 100), hoursBelowReserve: fin(d.hoursBelowReserve) }));
  const s: Summary = { solarKwh: fin(raw.summary?.solarKwh), loadKwh: fin(raw.summary?.loadKwh), gridKwh: fin(raw.summary?.gridKwh), gridHours: fin(raw.summary?.gridHours), minSocPct: fin(raw.summary?.minSocPct, 100), hoursBelowReserve: fin(raw.summary?.hoursBelowReserve), solarSharePct: fin(raw.summary?.solarSharePct),
    gridCost: typeof raw.summary?.gridCost === "number" && Number.isFinite(raw.summary.gridCost) ? raw.summary.gridCost : null, solarValue: typeof raw.summary?.solarValue === "number" && Number.isFinite(raw.summary.solarValue) ? raw.summary.solarValue : null, currency: typeof raw.summary?.currency === "string" ? raw.summary.currency : null };
  const reserve = fin(raw.reserve, 20);
  const tabs = (["today", "yesterday", "week"] as const).map((p) => `<button data-period="${p}" role="tab" aria-selected="${p === period}">${TAB[p]}</button>`).join("");
  const max = Math.max(0.1, ...days.map((d) => Math.max(d.solarKwh, d.loadKwh)));
  // Every calendar day of the period gets a slot; a day with no readings is drawn empty and dimmed, so "7 days" always shows seven.
  const slots: string[] = Array.isArray(raw.dates) && raw.dates.every((x) => typeof x === "string") && raw.dates.length ? raw.dates : days.map((d) => d.date);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const extra = days.filter((d) => !slots.includes(d.date)).map((d) => d.date); // readings outside the expected range still show
  const bars = [...slots, ...extra].map((date) => {
    const d = byDate.get(date);
    if (!d) return `<div class="day empty" title="${esc(date)}: no readings"><div class="pair"><div class="bar none"></div></div><span class="lbl">${esc(period === "week" ? dayLabel(date) : date.slice(5))}</span></div>`;
    return `<div class="day" title="${esc(d.date)}: solar ${kwh(d.solarKwh)} kWh, house ${kwh(d.loadKwh)} kWh, grid ${d.gridHours} h, lowest ${d.minSocPct}%">
      <div class="pair"><div class="bar sun" style="height:${Math.max(2, (d.solarKwh / max) * 100)}%"></div><div class="bar load${d.gridHours ? " gridded" : ""}" style="height:${Math.max(2, (d.loadKwh / max) * 100)}%"></div></div>
      <span class="lbl">${esc(period === "week" ? dayLabel(d.date) : d.date.slice(5))}</span></div>`;
  }).join("");
  const low = s.hoursBelowReserve ? `<b style="color:var(--alarm)">${s.hoursBelowReserve} h</b> at or below the ${reserve}% reserve` : `never below the <b>${reserve}%</b> reserve`;
  const learned = raw.learned?.loadProfile ? `Forecast uses this home's own pattern (${fin(raw.learned.days)} days${raw.learned.pvFactor !== null && raw.learned.pvFactor !== undefined ? `, array at ${Math.round(fin(raw.learned.pvFactor, 1) * 100)}% of clear-sky` : ""})` : `Learning: ${fin(raw.learned?.days)} of 3 days before the forecast uses this home's own pattern`;
  root.innerHTML = `
    <div class="head"><h1>${TITLE[period]}</h1><div class="tabs" role="tablist">${tabs}</div></div>
    ${raw.empty || days.length === 0 ? `<div class="placeholder">No readings for ${TITLE[period].toLowerCase()} yet. Powerline records one reading an hour, whether or not anyone is connected.</div>` : `
    <dl class="strip" style="margin:0">
      <div><dt>Solar</dt><dd>${kwh(s.solarKwh)}<em>kWh</em></dd></div>
      <div><dt>House</dt><dd>${kwh(s.loadKwh)}<em>kWh</em></dd></div>
      <div><dt>Without grid</dt><dd>${Math.round(s.solarSharePct)}<em>%</em></dd></div>
      <div><dt>Grid on</dt><dd>${s.gridHours}<em>h</em></dd></div>
    </dl>
    <div class="days"><h2>${period === "week" ? (days.length < 7 ? `By day · readings on ${days.length} of 7` : "By day") : "Hours of readings: " + days.reduce((a, d) => a + fin(d.hours), 0)}</h2>
      <div class="bars">${bars}</div>
      <div class="legend"><span><i style="background:var(--sun)"></i>solar</span><span><i style="background:var(--ink-3);opacity:.55"></i>house</span><span><i style="background:var(--grid);opacity:.7"></i>house, grid on</span></div>
    </div>
    <div class="foot"><span>Lowest battery <b>${s.minSocPct}%</b> · ${low}</span>${s.gridCost !== null && s.currency ? `<span>Grid <b>${money(s.gridCost, s.currency)}</b> · sun worth <b>${money(s.solarValue ?? 0, s.currency)}</b></span>` : ""}</div>`}
    <div class="foot" style="border-top:${raw.empty || days.length === 0 ? "1px solid var(--rule)" : "0"};padding-top:${raw.empty || days.length === 0 ? "10px" : "0"}">${esc(learned)}</div>`;
  root.querySelectorAll<HTMLButtonElement>("button[data-period]").forEach((b) => { b.onclick = () => load(b.dataset.period as Report["period"]); });
}

async function load(period: Report["period"]) {
  if (busy) return;
  busy = true; root.classList.add("busy"); root.querySelectorAll("button").forEach((b) => { (b as HTMLButtonElement).disabled = true; });
  status.textContent = "Adding up…";
  try {
    const res = await app.callServerTool({ name: "energy_report", arguments: { period } });
    if (res.isError) throw new Error(textOf(res));
    const sc = res.structuredContent as Report | undefined;
    if (sc) { render(sc); status.textContent = ""; }
    else status.textContent = "No report came back — try again.";
  } catch (e) { status.textContent = `Could not load: ${(e as Error).message}`; console.error(e); }
  finally { busy = false; root.classList.remove("busy"); root.querySelectorAll("button").forEach((b) => { (b as HTMLButtonElement).disabled = false; }); }
}

function textOf(r: { content?: Array<{ type: string; text?: string }> }): string {
  return r.content?.find((c) => c.type === "text")?.text ?? "no details";
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Report | undefined;
  try {
    if (result.isError) placeholder(`Powerline could not build the report: ${textOf(result)}`);
    else if (sc && typeof sc === "object") render(sc);
    else placeholder("No report came back. Ask for the energy report again.");
  } catch (e) { placeholder(`This card could not draw the report: ${(e as Error).message}`); console.error(e); }
};
app.ontoolcancelled = () => placeholder("Report cancelled. Ask for the energy report again.");
const applyTheme = (theme?: string) => { if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme; };
app.onhostcontextchanged = (ctx) => applyTheme(ctx.theme);
app.connect().then(() => applyTheme(app.getHostContext()?.theme)).catch((e) => {
  status.textContent = "not connected to Powerline";
  placeholder("This card could not connect to Powerline. Reload the conversation and ask again.");
  console.error(e);
});
