import { App } from "@modelcontextprotocol/ext-apps";

interface Appliance { name: string; watts: number; minutes: number }
type Source = "solar" | "grid" | "battery" | "none";
interface Item extends Appliance { startHour: number | null; onSurplus: boolean; source: Source; reason: string }
interface Plan { items: Item[]; minSocPct: number; hitsFloor: boolean; all: Appliance[]; selected: string[]; localHour: number; socNow: number; reserve: number; sunHours?: number[] }

const root = document.getElementById("root")!;
const status = document.getElementById("status")!;
const app = new App({ name: "powerline-planner", version: "0.4.0" }, {});
let current: Plan | null = null;
let busy = false;

const HOURS = 24;
const hh = (base: number, o: number) => `${String((base + o) % 24).padStart(2, "0")}:00`;
const esc = (s: string) => s.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c]!));
const COLOR: Record<Source, string> = { solar: "var(--sun)", grid: "var(--grid)", battery: "var(--charge)", none: "transparent" };
const WORD: Record<Source, string> = { solar: "on solar", grid: "on grid", battery: "on battery", none: "" };

/**
 * Daylight shading. Uses the hours the server actually forecasts sun for when it sends
 * them; otherwise falls back to a sunrise-to-sunset span around the plan's local hour.
 */
function sunBands(p: Plan): string {
  if (p.sunHours?.length) {
    return p.sunHours.map((h) => `<div class="sun" style="left:${(h / HOURS) * 100}%;width:${(1 / HOURS) * 100}%"></div>`).join("");
  }
  const left = ((6.5 - (p.localHour ?? 0) + 24) % 24 / HOURS) * 100;
  return `<div class="sun" style="left:${left}%;width:${(12.25 / HOURS) * 100}%"></div>`;
}

function render(p: Plan) {
  current = p;
  const items = p.items ?? [];
  const all = p.all ?? [];
  const selected = p.selected ?? items.map((i) => i.name);
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));

  const slots = items.filter((i) => i.startHour !== null).map((i) => {
    const left = (i.startHour! / HOURS) * 100;
    const width = Math.max(1.2, (Math.max(i.minutes, 30) / 60 / HOURS) * 100);
    return `<div class="slot" style="left:${left}%;width:${width}%;background:${COLOR[i.source]}" title="${esc(i.name)} at ${hh(p.localHour, i.startHour!)}"></div>`;
  }).join("");

  const rows = all.map((a) => {
    const it = byName.get(a.name.toLowerCase());
    const on = selected.some((s) => s.toLowerCase() === a.name.toLowerCase());
    const when = !on ? `<span class="when off">not planned</span>`
      : it && it.startHour !== null ? `<span class="when">${hh(p.localHour, it.startHour)}</span>`
      : `<span class="when off">no safe slot</span>`;
    const src = on && it && it.source !== "none" ? WORD[it.source] : "";
    return `<label class="row${on ? "" : " unpicked"}">
        <input type="checkbox" data-name="${esc(a.name)}"${on ? " checked" : ""} aria-label="${esc(a.name)}"/>
        <span class="name"><b>${esc(a.name)}</b><i>${a.watts} W · ${a.minutes} min</i></span>
        ${when}<span class="src">${src}</span>
      </label>`;
  }).join("");

  const lowColor = p.hitsFloor ? "var(--alarm)" : "var(--charge)";
  root.innerHTML = `
    <div class="head">
      <h1>Today's power plan</h1>
      <p>Tick what you want to run. Powerline fits it around the sun and your ${p.reserve ?? 20}% reserve.</p>
    </div>
    <div class="day">
      <div class="track">${sunBands(p)}${slots}</div>
      <div class="axis"><span>${hh(p.localHour, 0)}</span><span>${hh(p.localHour, 6)}</span><span>${hh(p.localHour, 12)}</span><span>${hh(p.localHour, 18)}</span><span>${hh(p.localHour, 23)}</span></div>
    </div>
    <div class="rows">${rows || '<div class="placeholder">No appliances yet. Say “remember the washing machine uses 500 watts for 45 minutes”.</div>'}</div>
    <div class="foot"><span>Battery now ${p.socNow ?? "–"}%</span>
      <span class="low" style="color:${lowColor}">Dips to ${p.minSocPct ?? "–"}% · reserve ${p.reserve ?? "–"}%</span></div>`;

  root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
    cb.onchange = () => replan();
  });
}

async function replan() {
  if (!current || busy) return;
  busy = true;
  root.classList.add("busy");
  status.textContent = "Re-planning…";
  const picked = [...root.querySelectorAll<HTMLInputElement>("input:checked")].map((c) => c.dataset.name!);
  const appliances = (current.all ?? []).filter((a) => picked.includes(a.name));
  try {
    const res = await app.callServerTool({ name: "plan_day", arguments: { appliances } });
    const sc = res.structuredContent as Plan | undefined;
    if (sc) render({ ...sc, all: sc.all?.length ? sc.all : current.all, selected: picked });
    status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) {
    status.textContent = `Could not re-plan: ${(e as Error).message}`;
    console.error(e);
  } finally {
    busy = false;
    root.classList.remove("busy");
  }
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Plan | undefined;
  try {
    if (sc) { render(sc); status.textContent = ""; }
    else root.innerHTML = `<div class="placeholder">No plan came back. Ask for today's plan again.</div>`;
  } catch (e) {
    root.innerHTML = `<div class="placeholder">This card could not draw the plan: ${esc((e as Error).message)}</div>`;
    console.error(e);
  }
};
app.connect().catch((e) => { status.textContent = "not connected to Powerline"; console.error(e); });
