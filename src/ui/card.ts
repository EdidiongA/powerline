import { App } from "@modelcontextprotocol/ext-apps";

interface Telemetry { at: string; pv_w: number; load_w: number; battery_w: number; soc_pct: number; grid_w: number | null; grid_available: boolean | null; source: string }
interface Point { hour: number; socPct: number; pvW: number; loadW: number; gridOn: boolean; batteryW: number }
interface Status { telemetry: Telemetry; profile: { reserveSocPct: number; batteryKwh: number }; forecast: Point[]; hoursToFloor: number | null; minSocPct: number }

const root = document.getElementById("root")!;
const srcEl = document.getElementById("src")!;
const app = new App({ name: "powerline-dashboard", version: "0.2.0" }, {});

const fmtW = (w: number) => (Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);

function tile(label: string, value: string, sub = "") {
  return `<div class="tile"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
}

function chart(points: Point[], floor: number): string {
  const W = 600, H = 140, padL = 28, padB = 18, padT = 8;
  const x = (i: number) => padL + (i / (points.length - 1)) * (W - padL - 6);
  const y = (soc: number) => padT + (1 - soc / 100) * (H - padT - padB);
  const socPath = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.socPct).toFixed(1)}`).join(" ");
  const maxPv = Math.max(1, ...points.map((p) => p.pvW));
  const pvPath = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(padT + (1 - p.pvW / maxPv) * (H - padT - padB)).toFixed(1)}`).join(" ") + ` L${x(points.length - 1).toFixed(1)},${H - padB} L${padL},${H - padB} Z`;
  const gridBands = points.map((p, i) => p.gridOn ? `<rect x="${x(i).toFixed(1)}" y="${padT}" width="${(x(1) - x(0)).toFixed(1)}" height="${H - padT - padB}" fill="currentColor" opacity=".06"/>` : "").join("");
  const ticks = [0, 6, 12, 18, 23].map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 4}" font-size="10" fill="currentColor" opacity=".6" text-anchor="middle">+${i}h</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    ${gridBands}
    <path d="${pvPath}" fill="#f2b632" opacity=".25"/>
    <line x1="${padL}" x2="${W - 6}" y1="${y(floor).toFixed(1)}" y2="${y(floor).toFixed(1)}" stroke="var(--bad)" stroke-dasharray="4 3" stroke-width="1"/>
    <path d="${socPath}" fill="none" stroke="var(--ok)" stroke-width="2.5"/>
    <text x="4" y="${y(100) + 8}" font-size="10" fill="currentColor" opacity=".6">100%</text>
    <text x="4" y="${y(floor) + 4}" font-size="10" fill="var(--bad)">${floor}%</text>
    ${ticks}
  </svg>`;
}

function render(s: Status) {
  const t = s.telemetry;
  srcEl.textContent = `${t.source} · ${new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const source = t.grid_available === null ? "solar + battery" : t.grid_available ? "grid" : t.pv_w > t.load_w ? "solar" : "battery";
  const socColor = t.soc_pct <= s.profile.reserveSocPct ? "var(--bad)" : t.soc_pct < s.profile.reserveSocPct + 15 ? "var(--warn)" : "var(--ok)";
  const floorMsg = t.soc_pct <= s.profile.reserveSocPct
    ? `🔴 Battery is <b>at or below the ${s.profile.reserveSocPct}% reserve</b> now.`
    : s.hoursToFloor !== null
    ? `⚠️ Reserve (${s.profile.reserveSocPct}%) reached in about <b>${s.hoursToFloor.toFixed(1)} h</b>.`
    : `✅ Battery stays above the ${s.profile.reserveSocPct}% reserve for 24 h (lowest ${s.minSocPct}%).`;
  root.innerHTML = `
    <div class="grid">
      ${tile("Solar", fmtW(t.pv_w))}
      ${tile("Load", fmtW(t.load_w), `on ${source}`)}
      ${tile("Battery", `${t.soc_pct}%`, Math.abs(t.battery_w) < 5 ? "idle" : `${t.battery_w > 0 ? "▲ charging" : "▼ discharging"} ${fmtW(Math.abs(t.battery_w))}`)}
      ${tile("Grid", t.grid_available === null ? "—" : t.grid_available ? "ON" : "OFF", t.grid_w ? fmtW(t.grid_w) : "")}
    </div>
    <div class="soc"><i style="width:${t.soc_pct}%;background:${socColor}"></i><b style="left:${s.profile.reserveSocPct}%"></b></div>
    <div class="msg">${floorMsg}</div>
    <div class="fc"><div class="l">Next 24 h — battery (green), solar (yellow), grid windows (shaded)</div>${chart(s.forecast, s.profile.reserveSocPct)}</div>`;
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Status | undefined;
  try { if (sc?.telemetry) render(sc); }
  catch (e) { root.innerHTML = `<div class="empty">Card error: ${(e as Error).message}</div>`; console.error(e); }
};
app.connect().catch((e) => { srcEl.textContent = "not connected"; console.error(e); });
