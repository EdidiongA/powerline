/** Decision tools: can_i_run, plan_day (planner card), arm_plan, disarm_plan. */
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { canRun, forecast, planDay } from "../forecast.js";
import { updateHousehold, type ArmedItem } from "../store/index.js";
import { assess, type SessionContext } from "../situation.js";
import { hourLabel, reasonFor } from "../config.js";
import { PLANNER_URI, cardHtml } from "../views.js";
import { presetFor } from "../presets.js";

const applianceList = z.array(z.object({ name: z.string(), watts: z.number().positive(), minutes: z.number().positive() })).optional();

/**
 * Which appliances to plan. Two callers send an empty list with opposite meanings: a
 * small model sends `[]` for "no override, use the stored list"; the planner card sends
 * `[]` with `exact: true` for "the user unticked everything". Honour both.
 */
function chooseList(appliances: Array<{ name: string; watts: number; minutes: number }> | undefined, exact: boolean | undefined, stored: Array<{ name: string; watts: number; minutes: number }>) {
  if (exact) return appliances ?? [];
  return appliances && appliances.length > 0 ? appliances : stored;
}

/** Armed items that still matter: not yet fired and not more than an hour past their start. */
function activeArmed(h: { armedPlan?: { items: Array<{ name: string; startAt: string; firedAt?: string }> } | null }, nowIso: string): string[] {
  const now = Date.parse(nowIso);
  return (h.armedPlan?.items ?? [])
    .filter((i) => !i.firedAt && Date.parse(i.startAt) >= now - 3_600_000)
    .map((i) => i.name);
}

export function registerPlanningTools(server: McpServer, ctx: SessionContext): void {
  server.registerTool("can_i_run", {
    title: "Can I run this appliance?",
    description: "Whether an appliance can run now without breaching the battery reserve; if not, the best time today. Accepts a known appliance name or explicit watts/minutes.",
    inputSchema: z.object({
      appliance: z.string().trim().min(1).max(60).describe("Name, e.g. 'washing machine'"),
      watts: z.number().positive().max(50_000).optional(),
      minutes: z.number().positive().max(1_440).optional(),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ appliance, watts, minutes }) => {
    const { h, input, localHour } = await assess(ctx);
    const known = h.appliances.find((a) => a.name.toLowerCase() === appliance.toLowerCase());
    const preset = known ? undefined : presetFor(appliance);
    const app = { name: appliance, watts: watts ?? known?.watts ?? preset?.watts ?? 0, minutes: minutes ?? known?.minutes ?? preset?.minutes ?? 60 };
    if (!app.watts) return { content: [{ type: "text", text: `I don't know how much power "${appliance}" uses. Tell me the watts, or add it with add_appliance.` }] };
    const assumed = !known && !watts && preset ? ` (assuming a typical ${preset.canonical}, ${preset.watts} W)` : "";
    const r = canRun(input, app);
    const when = r.bestStartHour !== null ? ` Best time: around ${hourLabel(localHour, r.bestStartHour)}.` : r.ok ? "" : " No good slot in the next 24 hours.";
    return { content: [{ type: "text", text: `${r.ok ? "Yes" : "Not now"} — ${r.reason}${when}${assumed}` }], structuredContent: { ...r, assumedWatts: !known && !watts ? app.watts : undefined } };
  });

  registerAppTool(server, "plan_day", {
    title: "Plan today's power",
    description: "Schedule the household's appliances (or a supplied list) across the next 24 h so the battery never breaches its reserve, preferring solar-surplus hours. Shows an interactive planner card where appliances can be toggled and re-planned.",
    inputSchema: z.object({
      appliances: applianceList.describe("Override the stored appliance list (used by the planner card when toggling)"),
      exact: z.boolean().optional().describe("Plan exactly the given list, even when it is empty (the planner card sets this)"),
    }),
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: PLANNER_URI } },
  }, async ({ appliances, exact }) => {
    const { h, profile, input, localHour, t, profileIsDefault } = await assess(ctx);
    const list = chooseList(appliances, exact, h.appliances);
    const sunHours = input.pvForecastW.map((w, i) => (w > input.loadForecastW[i] ? i : -1)).filter((i) => i >= 0);
    const armed = activeArmed(h, t.at);
    const common = { all: h.appliances, localHour, socNow: t.soc_pct, reserve: profile.reserveSocPct, sunHours, armed, profileIsDefault };
    if (list.length === 0) {
      const baseline = forecast(input);
      const text = h.appliances.length === 0
        ? "No appliances to plan yet. Say something like “remember the washing machine uses 500 watts for 45 minutes”."
        : `Nothing selected. Battery low point ${baseline.minSocPct}% (reserve ${profile.reserveSocPct}%) with no appliances scheduled.`;
      return { content: [{ type: "text", text }], structuredContent: { items: [], selected: [], minSocPct: baseline.minSocPct, hitsFloor: baseline.hitsFloor, ...common } };
    }
    const plan = planDay(input, list);
    const lines = plan.items.map((i) => i.startHour === null ? `• ${i.name}: skip today (${i.reason})` : `• ${i.name}: ${hourLabel(localHour, i.startHour)} (${i.reason})`);
    const text = `${lines.join("\n")}\nBattery low point ${plan.minSocPct}% (reserve ${profile.reserveSocPct}%).`;
    return { content: [{ type: "text", text }], structuredContent: { ...plan, selected: list.map((a) => a.name), ...common } };
  });

  server.registerTool("arm_plan", {
    title: "Arm today's plan",
    description: "Commit the day's plan. Powerline will then push a reminder over the session stream at each appliance's start time ('It's 10:00 — run the iron now'), without being asked. Pass a subset of appliances to arm only those; omit to arm every stored appliance. If a different plan is already armed and the host supports elicitation, the user is asked before it is replaced.",
    inputSchema: z.object({ appliances: applianceList, exact: z.boolean().optional() }),
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ appliances, exact }) => {
    const { h, profile, input, localHour, t } = await assess(ctx);
    const list = chooseList(appliances, exact, h.appliances);

    // Replacing a plan the user already committed to is the one destructive step here. When the
    // host can ask (MCP elicitation), ask; the planner card has its own "Re-arm" affordance, so
    // its calls (exact: true) skip the question. Hosts without elicitation proceed and say so.
    const pending = activeArmed(h, t.at);
    const wanted = list.map((a) => a.name.toLowerCase()).sort().join("|");
    const differs = pending.length > 0 && pending.map((n) => n.toLowerCase()).sort().join("|") !== wanted;
    if (differs && !exact && server.server.getClientCapabilities()?.elicitation) {
      try {
        const ask = await server.server.elicitInput({
          message: `A plan is already armed for ${pending.join(", ")}. Replace it with ${list.map((a) => a.name).join(", ")}?`,
          requestedSchema: { type: "object", properties: { replace: { type: "boolean", title: "Replace the armed plan", description: "Yes replaces it; no keeps the current reminders." } }, required: ["replace"] },
        }, { timeout: 60_000 });
        const yes = ask.action === "accept" && (ask.content as { replace?: boolean } | undefined)?.replace === true;
        if (!yes) return { content: [{ type: "text", text: `Kept the armed plan for ${pending.join(", ")}; nothing changed.` }], structuredContent: { armed: [], skipped: [], kept: pending } };
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (/timed? ?out|timeout/i.test(msg)) {
          // The person was still looking at the question. Silence is not consent.
          return { content: [{ type: "text", text: `No answer arrived, so I kept the armed plan for ${pending.join(", ")}; nothing changed. Ask again to replace it.` }], structuredContent: { armed: [], skipped: [], kept: pending } };
        }
        // A host that advertised elicitation but cannot actually answer must not block the user.
        console.error(`[arm_plan] elicitation failed (${msg}); proceeding`);
      }
    }
    if (list.length === 0) {
      await updateHousehold(ctx.userId, (hh) => { hh.armedPlan = null; });
      return { content: [{ type: "text", text: h.appliances.length ? "Nothing selected, so nothing is armed." : "Nothing to arm — add an appliance first." }], structuredContent: { armed: [], skipped: [] } };
    }
    const plan = planDay(input, list);
    const base = Date.parse(t.at);
    const items: ArmedItem[] = plan.items
      .filter((i) => i.startHour !== null && i.source !== "none")
      .map((i) => ({ name: i.name, watts: i.watts, minutes: i.minutes, source: i.source as ArmedItem["source"], startAt: new Date(base + i.startHour! * 3.6e6).toISOString() }));
    const skipped = plan.items.filter((i) => i.startHour === null).map((i) => i.name);

    // Anything scheduled for right now is told right now, rather than waiting for the monitor.
    const immediate = items.filter((i) => Date.parse(i.startAt) <= base + 60_000);
    for (const i of immediate) {
      i.firedAt = t.at;
      server.sendLoggingMessage({ level: "warning", logger: "powerline.alerts", data: { kind: "reminder", text: `Run the ${i.name} now — ${reasonFor(i.source)}.`, appliance: i.name, startAt: i.startAt, source: i.source } }).catch(() => {});
    }
    await updateHousehold(ctx.userId, (hh) => { hh.armedPlan = items.length ? { armedAt: t.at, items } : null; });

    const lines = items.map((i) => `• ${i.name} — ${i.firedAt ? "now" : hourLabel(localHour, Math.round((Date.parse(i.startAt) - base) / 3.6e6))} (${i.source})`);
    const text = items.length
      ? `Armed. ${immediate.length ? `${immediate.map((i) => i.name).join(" and ")} can run right now; ` : ""}I'll remind you at each start time:\n${lines.join("\n")}${skipped.length ? `\nNot armed (no safe slot today): ${skipped.join(", ")}` : ""}\nBattery low point ${plan.minSocPct}% (reserve ${profile.reserveSocPct}%).`
      : `Nothing could be scheduled safely today${skipped.length ? `: ${skipped.join(", ")}` : ""}.`;
    return { content: [{ type: "text", text }], structuredContent: { armed: items, skipped, minSocPct: plan.minSocPct } };
  });

  server.registerTool("remove_appliance", {
    title: "Remove an appliance",
    description: "Forget an appliance so it is no longer planned.",
    inputSchema: z.object({ name: z.string().trim().min(1) }),
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ name }) => {
    let removed = false;
    await updateHousehold(ctx.userId, (hh) => {
      const before = hh.appliances.length;
      hh.appliances = hh.appliances.filter((a) => a.name.toLowerCase() !== name.toLowerCase());
      removed = hh.appliances.length < before;
      if (removed && hh.armedPlan) {
        hh.armedPlan.items = hh.armedPlan.items.filter((i) => i.name.toLowerCase() !== name.toLowerCase());
        if (hh.armedPlan.items.length === 0) hh.armedPlan = null;
      }
    });
    return { content: [{ type: "text", text: removed ? `Removed ${name}.` : `I don't have an appliance called "${name}".` }] };
  });

  server.registerTool("disarm_plan", {
    title: "Disarm the plan",
    description: "Cancel the armed plan so no reminders fire.",
    inputSchema: z.object({}),
    annotations: { idempotentHint: true },
  }, async () => {
    await updateHousehold(ctx.userId, (hh) => { hh.armedPlan = null; });
    return { content: [{ type: "text", text: "Plan disarmed. No reminders will fire." }] };
  });

  registerAppResource(server, "Powerline planner", PLANNER_URI, { description: "Interactive appliance planner" },
    async () => ({ contents: [{ uri: PLANNER_URI, mimeType: RESOURCE_MIME_TYPE, text: await cardHtml("planner.html") }] }));
}
