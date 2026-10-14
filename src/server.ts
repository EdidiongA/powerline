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

export type { SessionContext } from "./situation.js";
export { checkCardsBuilt } from "./views.js";

export const VERSION = "0.13.2";

export function createServer(ctx: SessionContext, opts: { llm?: Summarizer } = {}): McpServer {
  const server = new McpServer(
    { name: "powerline", version: VERSION },
    {
      capabilities: { logging: {} }, // required, or sendLoggingMessage() is a silent no-op
      instructions: "Powerline is a home power copilot. It knows the household's solar array, battery, inverter and grid pattern. Use power_status for the current picture, can_i_run before recommending an appliance, plan_day to schedule, arm_plan when the user approves a plan (Powerline then reminds them at each start time), and evening_briefing for any briefing, summary or outlook; energy_report for what actually happened (today, yesterday, week) and what has been learned; outage_outlook for 'how long can we last if the grid goes'. Ask setup_system if no profile exists.",
    },
  );
  registerHouseholdTools(server, ctx);
  registerStatusTools(server, ctx);
  registerPlanningTools(server, ctx);
  registerBriefingTools(server, ctx, opts.llm);
  registerReportTools(server, ctx);
  registerPrompts(server);
  return server;
}
