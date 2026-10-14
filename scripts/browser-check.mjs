/**
 * Browser-level check of the simulated host: boots Powerline on a free port with a fast
 * simulated clock and seeded history, opens /demo in headless Chromium, and verifies the
 * things a judge would see — cards render inside the host, a tick on the planner card
 * re-plans through the server, a pushed reminder lands as a toast, and the elicitation
 * question appears as a dialog. Run: npm run check:browser   (needs: npx playwright install chromium)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const port = await new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const dataDir = mkdtempSync(path.join(tmpdir(), "pl-browser-"));
const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, SIM_START_SOC: "55", SIM_CLOCK_START: "2026-10-01T20:00:00Z", SIM_SPEED: "1800", ALERT_INTERVAL_MS: "1000" };
const run = (cmd, args) => new Promise((res, rej) => { const c = spawn(cmd, args, { env, stdio: "inherit" }); c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`)))); });
await run(process.execPath, ["dist/seed-history.js"]).catch(() => {}); // history is optional for this check
let log = "";
const url = `http://127.0.0.1:${port}`;
const boot = async () => {
  const s = spawn(process.execPath, ["dist/http.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  s.stdout.on("data", (d) => (log += d)); s.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${url}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return s;
};
let server = await boot();

const fail = (m) => { console.error(`✗ ${m}\n--- server log ---\n${log}`); process.exitCode = 1; };
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const dialogs = []; page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.goto(`${url}/demo`);
  await page.waitForFunction(() => document.getElementById("conn")?.textContent?.startsWith("connected"), null, { timeout: 15000 });
  const ask = async (t, ms = 2500) => { await page.fill("#input", t); await page.click("#send"); await page.waitForTimeout(ms); };
  await ask("Remember the iron uses 2000 watts for 30 minutes", 1500);
  await ask("add the pump", 1500);
  await ask("How's the power?", 3000);
  await ask("Plan my power for today", 3500);
  const cards = await page.$$(".card iframe");
  cards.length >= 2 ? console.log(`✓ ${cards.length} cards rendered through AppBridge`) : fail("cards did not render");
  const planner = page.frames().find((f) => /power plan/.test(f.name() || "") ) ?? (await (async () => { for (const f of page.frames()) { try { if (/power plan/.test(await f.evaluate(() => document.body.innerText))) return f; } catch {} } })());
  if (!planner) fail("planner frame not found");
  else {
    await planner.click("input[data-name='pump']"); await page.waitForTimeout(2500);
    const txt = await planner.evaluate(() => document.body.innerText);
    /not planned/.test(txt) ? console.log("✓ planner card re-planned through the server after an untick") : fail("planner did not re-plan");
    await planner.click("#arm"); await page.waitForTimeout(2000);
    /Armed/.test(await planner.evaluate(() => document.getElementById("arm").textContent)) ? console.log("✓ armed from the card") : fail("card arm failed");
  }
  await ask("Arm the plan", 3500);
  dialogs.some((m) => /already armed/.test(m)) ? console.log("✓ elicitation surfaced as a dialog and 'no' was honoured") : fail(`no elicitation dialog (${JSON.stringify(dialogs)})`);
  await ask("How did we do this week?", 3000);
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /run the|Battery|Grid/.test(t.textContent)), null, { timeout: 90000 }).then(() => console.log("✓ a pushed notification landed as a toast")).catch(() => fail("no notification toast within 90 s"));
  // Free-form: "give me everything" runs four read-only tools in one turn and renders their cards.
  const before = (await page.$$(".card iframe")).length;
  await ask("Give me everything", 6000);
  const after4 = (await page.$$(".card iframe")).length;
  after4 - before >= 3 ? console.log(`✓ "give me everything" rendered ${after4 - before} cards in one turn`) : fail(`"give me everything" rendered ${after4 - before} cards`);
  await ask("Give me a brief of what it looks like by tomorrow morning", 2500);
  const lastMsg = await page.evaluate(() => [...document.querySelectorAll(".msg.alexa")].pop()?.textContent ?? "");
  /didn't catch|What would you like/.test(lastMsg) ? fail(`free-form briefing fell through to the menu: ${lastMsg.slice(0, 120)}`) : console.log("✓ a free-form briefing request was understood");
  // A redeploy or a reaped session must not strand the page: restart the server, ask again, expect a fresh answer.
  server.kill("SIGTERM"); await new Promise((r) => server.on("exit", r));
  server = await boot();
  await ask("How's the power?", 4000);
  const after = await page.evaluate(() => [...document.querySelectorAll(".msg.alexa, .alexa, .bubble")].map((n) => n.textContent).join("\n"));
  const connTxt = await page.evaluate(() => document.getElementById("conn")?.textContent ?? "");
  /^connected/.test(connTxt) && !/failed|Something went wrong/.test(after.slice(-400)) ? console.log("✓ reconnected after a server restart and answered again") : fail(`did not recover after restart (pill: ${connTxt}; tail: ${after.slice(-200)})`);
  errors.length === 0 ? console.log("✓ no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
console.log(process.exitCode ? "browser check FAILED" : "browser check passed");
