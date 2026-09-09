import { App } from "@modelcontextprotocol/ext-apps";

interface Appliance { name: string; watts: number; minutes: number }
interface Item extends Appliance { startHour: number | null; onSurplus: boolean; source: "solar" | "grid" | "battery" | "none"; reason: string }
interface Plan { items: Item[]; minSocPct: number; hitsFloor: boolean; all: Appliance[]; selected: string[]; localHour: number; socNow: number; reserve: number }

const root = document.getElementById("root")!;
const sub = document.getElementById("sub")!;
const app = new App({ name: "powerline-planner", version: "0.2.0" }, {});
let current: Plan | null = null;

const hh = (base: number, o: number) => `${String((base + o) % 24).padStart(2, "0")}:00`;

function render(p: Plan) {
  current = p;
  const byName = new Map(p.items.map((i) => [i.name.toLowerCase(), i]));
  const rows = p.all.map((a) => {
    const it = byName.get(a.name.toLowerCase());
    const checked = p.selected.some((s) => s.toLowerCase() === a.name.toLowerCase());
    const when = !checked ? "" : it?.startHour === null ? `<span class="tag skip">skip today</span>` : `<span class="when">${hh(p.localHour, it!.startHour!)}</span><span class="tag ${it!.source === "solar" ? "sun" : ""}">${{ solar: "☀ solar", grid: "⚡ grid", battery: "🔋 battery", none: "" }[it!.source]}</span>`;
    return `<label class="row"><input type="checkbox" data-name="${a.name}" ${checked ? "checked" : ""}/><span class="name">${a.name}<small>${a.watts} W · ${a.minutes} min</small></span>${when}</label>`;
  }).join("");

  const cells = Array.from({ length: 24 }, (_, h) => {
    const on = p.items.some((i) => i.startHour !== null && h >= i.startHour && h < i.startHour + Math.ceil(i.minutes / 60));
    const sun = p.items.some((i) => i.onSurplus && i.startHour !== null && h >= i.startHour && h < i.startHour + Math.ceil(i.minutes / 60));
    return `<i class="${on ? (sun ? "sun" : "on") : ""}" title="${hh(p.localHour, h)}"></i>`;
  }).join("");

  const floorClass = p.hitsFloor ? "var(--bad)" : "var(--ok)";
  root.innerHTML = `${rows || '<div class="empty">No appliances yet — say "add appliance".</div>'}
    <div class="timeline">${cells}</div>
    <div class="ticks"><span>${hh(p.localHour, 0)}</span><span>${hh(p.localHour, 6)}</span><span>${hh(p.localHour, 12)}</span><span>${hh(p.localHour, 18)}</span><span>${hh(p.localHour, 23)}</span></div>
    <div class="foot"><span>Battery now ${p.socNow}%</span><span style="color:${floorClass}">Low point ${p.minSocPct}% · reserve ${p.reserve}%</span></div>`;

  root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
    cb.onchange = async () => {
      if (!current) return;
      const selected = [...root.querySelectorAll<HTMLInputElement>("input:checked")].map((c) => c.dataset.name!);
      const appliances = current.all.filter((a) => selected.includes(a.name));
      root.classList.add("busy");
      try {
        const res = await app.callServerTool({ name: "plan_day", arguments: { appliances } });
        const sc = res.structuredContent as Plan | undefined;
        if (sc?.all) render({ ...sc, selected: appliances.map((a) => a.name) });
      } finally { root.classList.remove("busy"); }
    };
  });
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Plan | undefined;
  if (sc?.all) render(sc);
};
app.connect().catch((e) => { sub.textContent = "not connected"; console.error(e); });
