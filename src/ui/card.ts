import { App } from "@modelcontextprotocol/ext-apps";

interface Telemetry { at: string; pv_w: number; load_w: number; battery_w: number; soc_pct: number; grid_w: number | null; grid_available: boolean | null; source: string }
interface Point { hour: number; socPct: number; pvW: number; loadW: number; gridOn: boolean; batteryW: number }
interface Status { telemetry: Telemetry; profile: { reserveSocPct: number; batteryKwh: number }; forecast: Point[]; hoursToFloor: number | null; minSocPct: number; localHour?: number; tzOffset?: number }

const root = document.getElementById("root")!;
const srcEl = document.getElementById("src")!;
const tsEl = document.getElementById("ts")!;
const VERSION = typeof __POWERLINE_VERSION__ === "string" ? __POWERLINE_VERSION__ : "dev";
const app = new App({ name: "powerline-dashboard", version: VERSION }, {});

const fin = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const kw = (w: number) => { const v = fin(w); return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}` : `${Math.round(v)}`; };
const kwUnit = (w: number) => (Math.abs(fin(w)) >= 1000 ? "kW" : "W");
const placeholder = (text: string) => { root.innerHTML = `<div class="placeholder">${esc(text)}</div>`; };
const esc = (s: string) => s.replace(/[<&>"']/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));

/** Plain-language answer to "is there enough?" — the thing a person actually wants. */
function verdict(s: Status): { line: string; sub: string } {
  const r = s.profile.reserveSocPct;
  const t = s.telemetry;
  if (t.soc_pct <= r) {
    const back = s.forecast.findIndex((p) => p.socPct > r);
    const sub = back === 0 ? "Charging — back above it within the hour"
      : back > 0 ? `Back above it in about ${back} ${back === 1 ? "hour" : "hours"}`
      : "Cut non-essential loads now";
    return { line: `Below your ${r}% reserve`, sub };
  }
  if (typeof s.hoursToFloor === "number" && Number.isFinite(s.hoursToFloor)) {
    const h = s.hoursToFloor;
    const when = h < 1 ? "within the hour" : h < 2 ? "in about an hour" : `in about ${Math.round(h)} hours`;
    return { line: `Reaches reserve ${when}`, sub: `Lowest ${fin(s.minSocPct)}%, reserve ${r}%` };
  }
  // Healthy: say when and how low it dips — that is the actual information.
  const low = s.forecast.reduce((a, b) => (b.socPct < a.socPct ? b : a), s.forecast[0]);
  const base = typeof s.localHour === "number" ? s.localHour : 0;
  const lowAt = `${String((base + low.hour) % 24).padStart(2, "0")}:00`;
  const nightAhead = base >= 16 || base < 5;
  return { line: nightAhead ? "Holds through the night" : "Holds for the next day", sub: `Lowest ${s.minSocPct}% around ${lowAt}` };
}

function ribbon(points: Point[], floor: number): string {
  const W = 640, H = 104, top = 6, bot = 6;
  const n = points.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (soc: number) => top + (1 - soc / 100) * (H - top - bot);
  const step = W / n;

  const gridBands = points.map((p, i) => (p.gridOn ? `<rect x="${(x(i) - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="var(--grid)" opacity=".10"/>` : "")).join("");

  const maxPv = Math.max(1, ...points.map((p) => p.pvW));
  const sunPts = points.map((p, i) => `${x(i).toFixed(1)},${(H - bot - (p.pvW / maxPv) * (H - top - bot) * 0.62).toFixed(1)}`).join(" ");
  const sun = `<polygon points="0,${H} ${sunPts} ${W},${H}" fill="var(--sun)" opacity=".22"/>`;

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.socPct).toFixed(1)}`).join(" ");
  const breached = points.some((p) => p.socPct <= floor);
  const now = `<circle cx="3.5" cy="${y(points[0].socPct).toFixed(1)}" r="3.5" fill="var(--charge)"/>`;

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Battery, solar and grid over the next 24 hours" style="height:104px">
    ${gridBands}${sun}
    <line x1="0" x2="${W}" y1="${y(floor).toFixed(1)}" y2="${y(floor).toFixed(1)}" stroke="var(--alarm)" stroke-width="1" stroke-dasharray="5 4"/>
    <path d="${line}" fill="none" stroke="${breached ? "var(--alarm)" : "var(--charge)"}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    ${now}
  </svg>`;
}

function render(raw: Status) {
  // Never trust a payload's arithmetic: a NaN anywhere would otherwise print "NaN".
  const s: Status = { ...raw, minSocPct: fin(raw.minSocPct), profile: { reserveSocPct: fin(raw.profile?.reserveSocPct, 20), batteryKwh: fin(raw.profile?.batteryKwh, 10) },
    telemetry: { ...raw.telemetry, pv_w: fin(raw.telemetry.pv_w), load_w: fin(raw.telemetry.load_w), battery_w: fin(raw.telemetry.battery_w), soc_pct: Math.min(100, Math.max(0, fin(raw.telemetry.soc_pct))) },
    forecast: raw.forecast.map((p) => ({ ...p, socPct: fin(p.socPct), pvW: fin(p.pvW), loadW: fin(p.loadW), batteryW: fin(p.batteryW) })) };
  const t = s.telemetry;
  const v = verdict(s);
  const gridOn = t.grid_available === true;
  const source = gridOn ? "grid" : t.pv_w > t.load_w ? "solar" : t.pv_w === 0 && t.load_w === 0 && Math.abs(t.battery_w) < 5 ? "nothing" : "battery";
  const flow = Math.abs(t.battery_w) < 5 ? "battery idle"
    : t.battery_w > 0 ? `charging ${kw(t.battery_w)} ${kwUnit(t.battery_w)}`
    : `drawing ${kw(Math.abs(t.battery_w))} ${kwUnit(t.battery_w)}`;
  const soc = t.soc_pct;
  const chargeColor = soc <= s.profile.reserveSocPct ? "var(--alarm)" : soc < s.profile.reserveSocPct + 15 ? "var(--sun)" : "var(--charge)";

  const hours = s.forecast.length;
  const base = typeof s.localHour === "number" && Number.isFinite(s.localHour) ? s.localHour : 0;
  const labelAt = (i: number) => `${String((base + i) % 24).padStart(2, "0")}:00`;

  root.innerHTML = `
    <div class="hero">
      <div class="charge" style="color:${chargeColor}">${Math.round(soc)}<span>%</span></div>
      <div class="verdict" role="status" aria-live="polite"><b>${esc(v.line)}</b><i>${esc(v.sub)}</i></div>
      <div class="flow">${esc(flow)}</div>
    </div>
    <div class="bar" role="progressbar" aria-label="Battery state of charge" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(soc)}"><u style="width:${Math.max(1, Math.min(100, soc))}%;background:${chargeColor}"></u><s style="left:${s.profile.reserveSocPct}%"></s></div>
    <dl class="strip">
      <div><dt>Solar</dt><dd>${kw(t.pv_w)}<em>${kwUnit(t.pv_w)}</em></dd></div>
      <div><dt>House</dt><dd>${kw(t.load_w)}<em>${kwUnit(t.load_w)}</em></dd></div>
      <div><dt>Running on</dt><dd style="text-transform:capitalize">${source}</dd></div>
    </dl>
    <div class="ribbon">
      <h2>Next ${hours} hours</h2>
      ${ribbon(s.forecast, s.profile.reserveSocPct)}
      <div class="axis"><span>${labelAt(0)}</span><span>${labelAt(Math.floor(hours / 3))}</span><span>${labelAt(Math.floor((2 * hours) / 3))}</span><span>${labelAt(hours - 1)}</span></div>
      <div class="legend">
        <span><i style="background:var(--charge)"></i>battery</span>
        <span><i style="background:var(--sun);opacity:.55"></i>solar</span>
        <span><i style="background:var(--grid);opacity:.4"></i>grid on</span>
        <span><i style="background:var(--alarm)"></i>${s.profile.reserveSocPct}% reserve</span>
      </div>
    </div>`;

  const pvSource = (raw as { pvSource?: string }).pvSource;
  srcEl.textContent = `${typeof t.source === "string" ? t.source : "unknown source"}${pvSource === "weather" ? " · weather forecast" : pvSource === "provider" ? " · vendor forecast" : ""}${(raw as { profileIsDefault?: boolean }).profileIsDefault ? " · default profile — say “set up my solar”" : ""}`;
  const d = new Date(t.at);
  const off = typeof s.tzOffset === "number" ? s.tzOffset : 1;
  tsEl.textContent = Number.isNaN(d.getTime()) ? "" : `${String((((d.getUTCHours() + off) % 24) + 24) % 24).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Status | undefined;
  try {
    if (result.isError) placeholder(`Powerline could not read the inverter: ${textOf(result)}`);
    else if (sc?.telemetry && Array.isArray(sc.forecast) && sc.forecast.length > 1) render(sc);
    else placeholder("No reading from the inverter yet. Ask for the power status again.");
  } catch (e) {
    placeholder(`This card could not draw the reading: ${(e as Error).message}`);
    console.error(e);
  }
};
app.ontoolcancelled = () => placeholder("Reading cancelled. Ask for the power status again.");

/** First text block of a tool result, for error display. */
function textOf(r: { content?: Array<{ type: string; text?: string }> }): string {
  return r.content?.find((c) => c.type === "text")?.text ?? "no details";
}

/** Follow the host's theme (light/dark) rather than only the OS setting. */
const applyTheme = (theme?: string) => { if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme; };
app.onhostcontextchanged = (ctx) => applyTheme(ctx.theme);
app.connect().then(() => applyTheme(app.getHostContext()?.theme)).catch((e) => {
  srcEl.textContent = "not connected to Powerline";
  placeholder("This card could not connect to Powerline. Reload the conversation and ask again.");
  console.error(e);
});
