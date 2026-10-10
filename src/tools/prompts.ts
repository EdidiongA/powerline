/**
 * MCP prompts: ready-made conversation starters a host can list and offer the user
 * (`prompts/list`). They are the spoken side of the tools — the phrasings a household
 * actually says — and they pin the sequence of tool calls that produces a good answer.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt("evening_outlook", {
    title: "Evening power outlook",
    description: "How are we for tonight? Battery, grid windows, what to avoid — one spoken paragraph.",
    argsSchema: z.object({}),
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text: "Give me tonight's power outlook. Use power_status for the current picture and evening_briefing for the spoken summary. If my system profile is still the default, tell me once how to set it up." } }],
  }));

  server.registerPrompt("plan_my_day", {
    title: "Plan today's appliances",
    description: "Fit the household's appliances around the sun and the reserve, then offer to arm reminders.",
    argsSchema: z.object({ appliances: z.string().optional().describe("Comma-separated names to include; omit for all known appliances") }),
  }, ({ appliances }) => ({
    messages: [{ role: "user", content: { type: "text", text: appliances
      ? `Plan my power for today for: ${appliances}. Use plan_day with those appliances, show the planner card, then ask whether to arm the plan so you remind me at each start time.`
      : "Plan my power for today. Use plan_day for everything you know about, show the planner card, then ask whether to arm the plan so you remind me at each start time." } }],
  }));

  server.registerPrompt("can_i_run", {
    title: "Can I run this now?",
    description: "Whether an appliance can run right now without breaching the reserve, and if not, the best time today.",
    argsSchema: z.object({ appliance: z.string().describe("e.g. iron"), minutes: z.string().optional().describe("Run length in minutes") }),
  }, ({ appliance, minutes }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Can I run the ${appliance}${minutes ? ` for ${minutes} minutes` : ""} now? Use can_i_run and answer in one sentence with the best time if the answer is no.` } }],
  }));

  server.registerPrompt("how_did_we_do", {
    title: "How did we do?",
    description: "What actually happened this week — solar, consumption, grid hours and cost — and what the forecast has learned.",
    argsSchema: z.object({ period: z.string().optional().describe("today, yesterday or week (default)") }),
  }, ({ period }) => ({
    messages: [{ role: "user", content: { type: "text", text: `How did we do ${period === "today" ? "today" : period === "yesterday" ? "yesterday" : "this week"}? Use energy_report with period "${period === "today" || period === "yesterday" ? period : "week"}", show the report card, and then use outage_outlook to say how long we would last if the grid went off now.` } }],
  }));

  server.registerPrompt("set_up_household", {
    title: "Set up my solar system",
    description: "First-run onboarding: array size, battery, inverter, reserve, then the appliances that matter.",
    argsSchema: z.object({}),
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text: "Help me set up Powerline. Ask for my array size in kW, battery capacity in kWh, inverter rating in kW and the battery reserve I want to keep (suggest 20%), call setup_system, then ask which heavy appliances I run (iron, washing machine, pump, kettle…) with their watts and minutes and add each with add_appliance. Finish by showing power_status." } }],
  }));
}
