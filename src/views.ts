/**
 * MCP App views, served as ui:// resources.
 * Each bundle is ~240 KB (it carries the ext-apps client). Read once, then served
 * from memory: hosts fetch the resource on every render.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

export const DASHBOARD_URI = "ui://powerline/dashboard.html";
export const PLANNER_URI = "ui://powerline/planner.html";
export const REPORT_URI = "ui://powerline/report.html";
export const HOUSEHOLD_URI = "powerline://household";

export async function cardHtml(file: "card.html" | "planner.html" | "report.html" | "demo.html"): Promise<string> {
  const hit = cache.get(file);
  if (hit) return hit;
  // dist/views.js → dist/ui/<file>;  src/views.ts via tsx → dist/ui/<file>
  for (const p of [path.resolve(here, "ui", file), path.resolve(here, "../dist/ui", file)]) {
    try {
      const html = await fs.readFile(p, "utf8");
      cache.set(file, html);
      return html;
    } catch { /* try next location */ }
  }
  console.error(`[powerline] MCP App view ${file} not found — run \`npm run build:ui\``);
  // Not cached: the next request should retry after the operator builds the views.
  return `<!doctype html><body style="font-family:system-ui;padding:12px;color:#d64545">Powerline card <b>${file}</b> is not built. Run <code>npm run build:ui</code> and restart the server.</body>`;
}

/** Warn at startup if the card bundles are missing, instead of failing silently at render time. */
export async function checkCardsBuilt(): Promise<void> {
  await Promise.all([cardHtml("card.html"), cardHtml("planner.html"), cardHtml("report.html"), cardHtml("demo.html")]);
}
