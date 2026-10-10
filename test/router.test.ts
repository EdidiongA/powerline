import { test } from "node:test";
import assert from "node:assert/strict";
import { routeByRules } from "../src/demo/router.js";

const ALL = ["setup_system", "add_appliance", "list_appliances", "remove_appliance", "log_grid_event", "power_status", "can_i_run", "plan_day", "arm_plan", "disarm_plan", "evening_briefing", "energy_report", "outage_outlook", "set_tariff"];
const r = (u: string) => routeByRules(u, ALL);

test("router: the README phrasings map to the right tools with the right arguments", () => {
  assert.deepEqual(r("Set up my solar: 4.5 kW array, 10 kWh battery, 5 kW inverter, 20% reserve").input, { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 });
  assert.equal(r("set up my solar system").tool, null);
  assert.deepEqual(r("Remember the iron uses 2000 watts for 30 minutes"), { tool: "add_appliance", input: { name: "iron", watts: 2000, minutes: 30 }, text: "" });
  assert.deepEqual(r("add the kettle").input, { name: "kettle" });
  assert.deepEqual(r("remember the pump is 1.1 kW for 1 hour").input, { name: "pump", watts: 1100, minutes: 60 });
  assert.equal(r("How's the power?").tool, "power_status");
  assert.equal(r("how is the battery").tool, "power_status");
  assert.deepEqual(r("Can I run the iron for 30 minutes?").input, { appliance: "iron", minutes: 30 });
  assert.deepEqual(r("can I run the washing machine now").input, { appliance: "washing machine" });
  assert.deepEqual(r("could I use the AC for 2 hours").input, { appliance: "ac", minutes: 120 });
  assert.equal(r("Plan my power for today").tool, "plan_day");
  assert.equal(r("Arm the plan").tool, "arm_plan");
  assert.equal(r("cancel the reminders").tool, "disarm_plan");
  assert.deepEqual(r("How did we do this week?").input, { period: "week" });
  assert.deepEqual(r("what did the grid cost yesterday").input, { period: "yesterday" });
  assert.equal(r("How long can we last if the grid goes?").tool, "outage_outlook");
  assert.equal(r("is there light tonight").tool, "outage_outlook");
  assert.equal(r("Give me the evening briefing").tool, "evening_briefing");
  assert.deepEqual(r("NEPA just went off").input, { on: false });
  assert.deepEqual(r("the light is back").input, { on: true });
  assert.deepEqual(r("grid costs 225 naira a unit").input, { perKwh: 225, currency: "NGN" });
  assert.equal(r("what appliances do you know about").tool, "list_appliances");
  assert.deepEqual(r("forget the pump").input, { name: "pump" });
});

test("router: empty, nonsense and unavailable tools are handled with a sentence, never a crash", () => {
  assert.equal(r("").tool, null); assert.match(r("").text, /how's the power/);
  assert.equal(r("tell me a joke").tool, null);
  const limited = routeByRules("plan my day", ["power_status"]);
  assert.equal(limited.tool, null); assert.match(limited.text, /not available/);
  assert.doesNotThrow(() => r("💡💡💡 ???"));
  assert.doesNotThrow(() => r("x".repeat(10000)));
});
