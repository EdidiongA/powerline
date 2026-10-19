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
  assert.match(r("tell me a joke").text, /give me everything/, "an unknown request gets concrete examples, not a vague menu");
  assert.match(r("hello").text, /I'm Powerline/);
  const limited = routeByRules("plan my day", ["power_status"]);
  assert.equal(limited.tool, null); assert.match(limited.text, /not available/);
  assert.doesNotThrow(() => r("💡💡💡 ???"));
  assert.doesNotThrow(() => r("x".repeat(10000)));
});

test("router: free-form phrasings people actually type (found on the live demo)", () => {
  // The two that failed on 12 Oct.
  assert.equal(r("Give me a brief of what it looks like by tomorrow morning").tool, "evening_briefing");
  const all = r("Do all of them");
  assert.deepEqual([all.tool, ...(all.also ?? []).map((a) => a.tool)], ["power_status", "plan_day", "outage_outlook", "energy_report"]);
  assert.ok(!(all.also ?? []).some((a) => a.tool === "arm_plan"), "'everything' never arms or changes state");
  assert.equal(r("give me everything").tool, "power_status");
  assert.equal(r("full rundown please").also?.length, 3);
  // Will it last / enough power
  assert.equal(r("will the battery last till morning?").tool, "evening_briefing");
  assert.equal(r("do we have enough power for tonight").tool, "evening_briefing");
  assert.equal(r("what's the forecast").tool, "evening_briefing");
  // Plan wins over time words
  assert.equal(r("plan tomorrow morning for me").tool, "plan_day");
  assert.equal(r("when should I do the laundry").tool, "plan_day");
  // Status synonyms
  assert.equal(r("what's the electricity situation").tool, "power_status");
  assert.equal(r("give me an update").tool, "power_status");
  // Existing intents still win where they did
  assert.equal(r("How long can we last if the grid goes?").tool, "outage_outlook");
  assert.equal(r("is there light tonight").tool, "outage_outlook");
  assert.deepEqual(r("NEPA just went off").input, { on: false });
  assert.equal(r("cancel everything").also, undefined, "a cancel is never turned into the read-everything bundle");
  // Availability is respected in the multi-call path
  const only = routeByRules("do all of them", ["power_status", "energy_report"]);
  assert.deepEqual([only.tool, ...(only.also ?? []).map((a) => a.tool)], ["power_status", "energy_report"]);
  assert.equal(routeByRules("do all of them", ["arm_plan"]).tool, null);
});

test("router: precedence and hostile input — events before appliances, reports before can-I-run, no quadratic regex", () => {
  assert.deepEqual(r("note nepa took light").input, { on: false });
  assert.deepEqual(r("we just got light").input, { on: true });
  assert.equal(r("cancel everything").tool, "disarm_plan");
  assert.equal(r("forget everything").tool, "disarm_plan");
  assert.equal(r("set up reminders for the plan").tool, "arm_plan");
  assert.equal(r("could you run the energy report").tool, "energy_report");
  assert.equal(r("switch off the fridge").tool, null); assert.match(r("switch off the fridge").text, /can't switch/);
  assert.deepEqual(r("can I run the washing machine right now").input, { appliance: "washing machine" });
  const t0 = Date.now(); r("can " + "run ".repeat(14_900) + "5"); assert.ok(Date.now() - t0 < 200, "a pathological utterance must not stall the event loop");
});

test("router: prepaid meter, balance, outlook and purchases", () => {
  const U = [...ALL, "set_meter", "prepaid_units", "buy_units"];
  const u = (s: string) => routeByRules(s, U);
  assert.deepEqual(u("My meter is 1111 1111 1111 1, Ikeja Electric"), { tool: "set_meter", input: { meterNumber: "1111111111111", disco: "ikeja electric" }, text: "" });
  assert.deepEqual(u("my meter number is 1111111111111 ikedc and it shows 40 units").input, { meterNumber: "1111111111111", disco: "ikedc", unitsLeft: 40 });
  assert.deepEqual(u("the meter shows 12.5 units").input, { unitsLeft: 12.5 });
  for (const q of ["How are my units?", "will my units last till morning", "do I need to buy units", "how many units do I have left"]) assert.equal(u(q).tool, "prepaid_units", q);
  assert.deepEqual(u("Buy 5,000 naira of units").input, { amount: 5000 });
  assert.deepEqual(u("buy ₦3000 units").input, { amount: 3000 });
  assert.deepEqual(u("recharge 5k").input, { amount: 5000 });
  assert.deepEqual(u("top up my meter"), { tool: "buy_units", input: {}, text: "" });
  assert.equal(u("buy light").tool, "buy_units");
  // The tariff and appliance rules still win where they should.
  assert.equal(u("grid costs 225 naira a unit").tool, "set_tariff");
  assert.equal(u("add the kettle").tool, "add_appliance");
  // Not purchases, not balance questions (each was mis-routed once).
  assert.equal(u("each unit costs 225 naira").tool, "set_tariff");
  assert.equal(u("how many units did we use yesterday").tool, "energy_report");
  assert.equal(u("can I run the iron for 30 minutes on units").tool, "can_i_run");
  assert.notEqual(u("buy a 10k battery").tool, "buy_units");
  assert.notEqual(u("recharge the battery from grid electricity").tool, "buy_units");
  assert.equal(u("buy 20 units").tool, null, "units are kWh; buy_units takes naira, so ask");
  assert.match(u("buy 20 units").text, /naira/);
  assert.equal(u("is my meter ok").tool, "prepaid_units");
  assert.notEqual(u("should I buy a bigger battery").tool, "prepaid_units");
  assert.notEqual(u("how many units will the iron use").tool, "prepaid_units");
  // Plain numbers in a purchase are naira; "add … to my meter" is a purchase; "units finished" is a balance of zero.
  assert.deepEqual(u("top up my meter with 5000").input, { amount: 5000 });
  assert.deepEqual(u("recharge my meter 2000").input, { amount: 2000 });
  assert.deepEqual(u("buy units worth 3000").input, { amount: 3000 });
  assert.deepEqual(u("buy 5000").input, { amount: 5000 });
  assert.deepEqual(u("add 5000 naira to my meter"), { tool: "buy_units", input: { amount: 5000 }, text: "" });
  assert.deepEqual(u("no light, units finished"), { tool: "set_meter", input: { unitsLeft: 0 }, text: "" });
  assert.equal(u("when will my units run out").tool, "prepaid_units");
  // "Light is out" is a grid outage in Lagos, never an empty meter; spaced meter numbers, airtime and phones are not naira.
  for (const q of ["light is out", "street light is out", "light off, battery empty", "my light finished"]) assert.notEqual(u(q).tool, "set_meter", q);
  assert.equal(u("nepa took light, units finished").tool, "log_grid_event");
  assert.deepEqual(u("top up meter 1111 1111 1111 1 with 5000").input, { amount: 5000 });
  assert.deepEqual(u("buy units for meter 1111 1111 1111 1").input, {});
  for (const q of ["buy 2 kettles", "buy 1000 airtime", "recharge 08031234567 with 1000"]) assert.notEqual(u(q).tool, "buy_units", q);
  // Thousands separators survive cleaning.
  assert.deepEqual(r("remember the iron uses 2,000 watts for 30 minutes").input, { name: "iron", watts: 2000, minutes: 30 });
  // On a server without the units tools, the host says so instead of guessing.
  assert.equal(r("buy 5000 naira of units").tool, null);
});
