import { App } from "@modelcontextprotocol/ext-apps";

interface Appliance { name: string; watts: number; minutes: number }
type Source = "solar" | "grid" | "battery" | "none";
interface Item extends Appliance { startHour: number | null; onSurplus: boolean; source: Source; reason: string }
interface Plan { items: Item[]; minSocPct: number; hitsFloor: boolean; all: Appliance[]; selected: string[]; localHour: number; socNow: number; reserve: number; sunHours?: number[]; armed?: string[] }

const root = document.getElementById("root")!;
const status = document.getElementById("status")!;
const VERSION = typeof __POWERLINE_VERSION__ === "string" ? __POWERLINE_VERSION__ : "dev";
const app = new App({ name: "powerline-planner", version: VERSION }, {});
let current: Plan | null = null;
let busy = false;
let pendingReplan = false; // a toggle arrived while a re-plan was in flight

const HOURS = 24;
const fin = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const hh = (base: number, o: number) => `${String((((fin(base) + o) % 24) + 24) % 24).padStart(2, "0")}:00`;
const placeholder = (text: string) => { root.innerHTML = `<div class="placeholder">${esc(text)}</div>`; };
const esc = (s: string) => s.replace(/[<&>"']/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
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

function render(raw: Plan) {
  const p: Plan = { ...raw, localHour: fin(raw.localHour), socNow: fin(raw.socNow), reserve: fin(raw.reserve, 20), minSocPct: fin(raw.minSocPct) };
  current = p;
  // Normalise every item: a missing start hour is "unscheduled", an unknown source is "none".
  const items: Item[] = (Array.isArray(p.items) ? p.items : []).filter((i) => i && typeof i.name === "string").map((i) => ({
    ...i, watts: fin(i.watts), minutes: fin(i.minutes),
    startHour: typeof i.startHour === "number" && Number.isFinite(i.startHour) ? i.startHour : null,
    source: (i.source in COLOR ? i.source : "none") as Source,
  }));
  const all = (Array.isArray(p.all) ? p.all : []).filter((a) => a && typeof a.name === "string");
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
        <input type="checkbox" data-name="${esc(a.name)}"${on ? " checked" : ""} aria-label="Run ${esc(a.name)} today"/>
        <span class="name"><b>${esc(a.name)}</b><i>${fin(a.watts)} W · ${fin(a.minutes)} min</i></span>
        ${when}<span class="src">${src}</span>
      </label>`;
  }).join("");

  const lowColor = p.hitsFloor ? "var(--alarm)" : "var(--charge)";
  const scheduled = items.filter((i) => i.startHour !== null);
  const armedNames = (Array.isArray(p.armed) ? p.armed : []).map((a) => String(a).toLowerCase());
  // "Armed" means the plan on screen is the one Powerline is holding. If the user has
  // changed the selection since arming, the button offers to re-arm instead.
  const armedNow = armedNames.length > 0 && scheduled.length > 0 && scheduled.every((i) => armedNames.includes(i.name.toLowerCase())) && armedNames.every((a) => scheduled.some((i) => i.name.toLowerCase() === a));
  const armedElsewhere = armedNames.length > 0 && !armedNow;
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
    ${all.length && !selected.length ? '<div class="placeholder" style="padding-top:0">Nothing selected. Tick an appliance to plan it.</div>' : ""}
    <div class="foot">
      <div class="stat"><span>Battery now ${p.socNow ?? "–"}%</span>
        <span class="low" style="color:${lowColor}">Dips to ${p.minSocPct ?? "–"}% · reserve ${p.reserve ?? "–"}%</span></div>
      ${all.length ? `<button class="arm${armedNow ? " on" : ""}" id="arm" aria-pressed="${armedNow}" ${scheduled.length || armedNames.length ? "" : "disabled"} title="${armedNow ? "Cancel reminders" : armedElsewhere ? "A different plan is armed — click to arm this one" : "Powerline will remind you at each start time"}">${armedNow ? "✓ Armed — reminders on" : armedElsewhere ? "Re-arm with this plan" : "Arm plan"}</button>` : ""}
    </div>`;
  const armBtn = root.querySelector<HTMLButtonElement>("#arm");
  if (armBtn) armBtn.onclick = () => (armedNow ? disarm() : scheduled.length ? arm() : disarm());

  root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
    cb.onchange = () => replan();
  });
  if (armedElsewhere) status.textContent = "The armed plan differs from this selection.";
}

/** Freeze every control while a server call is in flight — keyboard included, which the overlay alone does not stop. */
function setBusy(on: boolean, label = "") {
  busy = on;
  root.classList.toggle("busy", on);
  root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => { el.disabled = on || (el.id === "arm" && el.dataset.keepDisabled === "1"); });
  root.setAttribute("aria-busy", String(on));
  if (label) status.textContent = label;
}

function picked(): string[] {
  return [...root.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")].map((c) => c.dataset.name!);
}

async function replan() {
  if (!current) return;
  if (busy) { pendingReplan = true; return; }   // coalesce: run once more after this one lands
  const chosen = picked();
  const appliances = (current.all ?? []).filter((a) => chosen.includes(a.name));
  setBusy(true, "Re-planning…");
  try {
    // `exact` makes an empty list mean "nothing", not "use the stored list".
    const res = await app.callServerTool({ name: "plan_day", arguments: { appliances, exact: true } });
    const sc = res.structuredContent as Plan | undefined;
    if (res.isError) throw new Error(textOf(res));
    if (sc) render({ ...sc, all: sc.all?.length ? sc.all : current.all, selected: chosen });
    status.textContent = chosen.length ? "Updated" : "Nothing selected";
  } catch (e) {
    status.textContent = `Could not re-plan: ${(e as Error).message}`;
    console.error(e);
  } finally {
    setBusy(false);
    if (pendingReplan) { pendingReplan = false; void replan(); }
  }
}

function textOf(r: { content?: Array<{ type: string; text?: string }> }): string {
  return r.content?.find((c) => c.type === "text")?.text ?? "no details";
}

async function arm() {
  if (!current || busy) return;
  const chosen = picked();
  const appliances = (current.all ?? []).filter((a) => chosen.includes(a.name));
  setBusy(true, "Arming…");
  try {
    const res = await app.callServerTool({ name: "arm_plan", arguments: { appliances, exact: true } });
    if (res.isError) throw new Error(textOf(res));
    const sc = res.structuredContent as { armed?: Array<{ name: string; firedAt?: string }>; skipped?: string[] } | undefined;
    // Items due right now were announced by the server at arm time; only the rest are pending reminders.
    const now = (sc?.armed ?? []).filter((a) => a.firedAt).map((a) => a.name);
    const pending = (sc?.armed ?? []).filter((a) => !a.firedAt).map((a) => a.name);
    render({ ...current, selected: chosen, armed: pending });
    const parts = [
      now.length ? `Run the ${now.join(" and ")} now` : "",
      pending.length ? `${pending.length} reminder${pending.length === 1 ? "" : "s"} armed` : "",
      sc?.skipped?.length ? `no safe slot for ${sc.skipped.join(", ")}` : "",
    ].filter(Boolean);
    status.textContent = parts.length ? parts.join(" · ") : "Nothing could be armed — no safe slot today";
  } catch (e) { status.textContent = `Could not arm: ${(e as Error).message}`; console.error(e); }
  finally { setBusy(false); }
}

async function disarm() {
  if (!current || busy) return;
  setBusy(true, "Disarming…");
  try {
    const res = await app.callServerTool({ name: "disarm_plan", arguments: {} });
    if (res.isError) throw new Error(textOf(res));
    render({ ...current, armed: [] });
    status.textContent = "Reminders off";
  } catch (e) { status.textContent = `Could not disarm: ${(e as Error).message}`; console.error(e); }
  finally { setBusy(false); }
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Plan | undefined;
  try {
    if (result.isError) placeholder(`Powerline could not plan: ${textOf(result)}`);
    else if (sc && typeof sc === "object") { render(sc); if (!status.textContent) status.textContent = ""; }
    else placeholder("No plan came back. Ask for today's plan again.");
  } catch (e) {
    placeholder(`This card could not draw the plan: ${(e as Error).message}`);
    console.error(e);
  }
};
app.ontoolcancelled = () => placeholder("Planning cancelled. Ask for today's plan again.");
/** Follow the host's theme (light/dark) rather than only the OS setting. */
const applyTheme = (theme?: string) => { if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme; };
app.onhostcontextchanged = (ctx) => applyTheme(ctx.theme);
app.connect().then(() => applyTheme(app.getHostContext()?.theme)).catch((e) => {
  status.textContent = "not connected to Powerline";
  placeholder("This card could not connect to Powerline. Reload the conversation and ask again.");
  console.error(e);
});
