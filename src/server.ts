/**
 * Powerline MCP server — composition root.
 * One McpServer per MCP session (see http.ts). Tools live in src/tools/, grouped by
 * concern; the household's situation is assessed in src/situation.ts; state persists
 * via src/store/. This file only wires them together.
 */
import { McpServer } from "@modelcontextprotocol/server";
import type { SessionContext } from "./situation.js";
import { registerHouseholdTools } from "./tools/household.js";
import { registerStatusTools } from "./tools/status.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerBriefingTools, type Summarizer } from "./tools/briefing.js";
import { registerPrompts } from "./tools/prompts.js";
import { registerReportTools } from "./tools/report.js";
import { registerUnitsTools } from "./tools/units.js";
import { installAlertChannel } from "./push.js";
import type { UnitsVendor } from "./vending.js";

export type { SessionContext } from "./situation.js";
export { checkCardsBuilt } from "./views.js";

export const VERSION = "0.14.0";

export function createServer(ctx: SessionContext, opts: { llm?: Summarizer; vendor?: UnitsVendor } = {}): McpServer {
  const server = new McpServer(
    { name: "powerline", version: VERSION },
    {
      // resources.subscribe: alerts are pushed as updates to powerline://alerts (see push.ts);
      // logging stays declared for hosts that have not subscribed (and is required, or sendLoggingMessage() is a silent no-op).
      capabilities: { logging: {}, resources: { subscribe: true } },
      instructions: "Powerline is a home power copilot. It knows the household's solar array, battery, inverter and grid pattern. Use power_status for the current picture, can_i_run before recommending an appliance, plan_day to schedule, arm_plan when the user approves a plan (Powerline then reminds them at each start time), and evening_briefing for any briefing, summary or outlook; energy_report for what actually happened (today, yesterday, week) and what has been learned; outage_outlook for 'how long can we last if the grid goes'; prepaid_units for how long the prepaid meter's units will last, set_meter to record the meter, and buy_units ONLY when the user asks to buy or top up (the user always confirms before anything is bought). Ask setup_system if no profile exists.",
    },
  );
  registerHouseholdTools(server, ctx);
  registerStatusTools(server, ctx);
  registerPlanningTools(server, ctx);
  registerBriefingTools(server, ctx, opts.llm);
  registerReportTools(server, ctx);
  registerUnitsTools(server, ctx, opts.vendor);
  registerPrompts(server);
  installAlertChannel(server);
  return server;
}
