---
name: powerline-home-power
description: Answer a household's power questions through the Powerline MCP server — current solar/battery/grid state, "can I run the iron now?", planning appliances around the sun and the battery reserve, arming reminders, and the evening outlook. Use when the user mentions their inverter, solar, battery, generator, grid outage, NEPA/light, load shedding, or asks whether or when to run an appliance.
license: MIT
compatibility: Requires a running Powerline MCP server (Streamable HTTP, spec 2025-11-25) connected to the host. No other tools needed.
metadata:
  author: EdidiongA
  version: "0.13.1"
  repo: https://github.com/EdidiongA/powerline
---

# Powerline — home power copilot

Powerline turns a solar-plus-battery household's inverter into something you can reason
with. It forecasts the next 24 hours of state of charge from live telemetry, a learned grid
pattern and a clear-sky solar model, and it keeps the household's profile and appliances
between sessions. **Never estimate power figures yourself; every number comes from a tool.**

## Tools you have

| Tool | Use it when | Notes |
| --- | --- | --- |
| `power_status` | "How's the power?", any status question, and before giving advice | Renders the dashboard card. `structuredContent.profileIsDefault` is `true` until the household is set up. |
| `can_i_run` | "Can I run X (for N minutes)?" | Answers yes/not-now with the projected low point and `bestStartHour` (offset from now). Unknown appliance → ask for watts or add it. |
| `plan_day` | "Plan my day/power", "when should I run…" | Renders the interactive planner card. Pass `appliances` only to override the stored list. |
| `arm_plan` / `disarm_plan` | The user approves a plan / wants reminders off | After arming, Powerline pushes a reminder at each start time on its own. Items due now are announced in the reply. If a different plan is already armed, the server may ask the user (elicitation) before replacing it; relay the question and the answer, do not answer for them. |
| `evening_briefing` | "Briefing", "outlook", "how are we for tonight?" | One spoken paragraph. `_meta.bedrock` tells you whether a language model phrased it. |
| `setup_system` | First run, or the user describes their system | Values over 100 kW / 1000 kWh are read as W / Wh. Reserve default 20 %. Pass `tzOffset` when the user says where they are. |
| `add_appliance` / `remove_appliance` / `list_appliances` | The user names an appliance, with or without its draw | Common appliances have presets; the reply says which figure was assumed — relay that so the user can correct it. Names are matched case-insensitively; re-adding updates. |
| `log_grid_event` | "Grid just came on / went off" | Only a change of state is recorded; the alert monitor logs flips it observes itself. |
| `energy_report` | "How did we do today / this week?", "what did the grid cost?" | Renders the report card. Read `structuredContent.learned` to say whether the forecast is using this home's own pattern yet. Empty history → relay the "no readings yet" message, do not invent figures. |
| `outage_outlook` | "How long can we last if the grid goes?", "is there light tonight?" | Hours of autonomy and the usual off-hours. `autonomyHours: null` means already below reserve — say so plainly. |
| `set_tariff` | The user says what a unit of grid power costs | Reports then show cost and the value of the sun. |

## How to behave

1. **Status first.** For any advice, call `power_status` before answering so you speak from the
   current reading, not memory.
2. **Default profile.** If `profileIsDefault` is true, give the answer and add one sentence:
   *"That's against a default 4.5 kW / 10 kWh system — say 'set up my solar' to use yours."*
   Say it once per conversation, not every turn.
3. **"Can I run…"** → `can_i_run`. Reply in one sentence. If `ok` is false and `bestStartHour`
   is a number, convert it to a clock time (it is hours from now) and say it:
   *"Not now — the battery would dip to 14 %. Best around 09:00, when the sun covers it."*
4. **Planning** → `plan_day`, then **offer to arm**: *"Shall I remind you at each start time?"*
   On yes → `arm_plan`. Repeat back what was armed and what was skipped and why.
5. **Reminders arrive as notifications** (`notifications/message`, logger `powerline.alerts`,
   `data.kind` = `reminder` | `low` | `critical` | `grid`). Relay them in one short line the
   moment they arrive; do not wait to be asked.
6. **Briefing** → `evening_briefing`. Read it as given; do not append numbers of your own.
7. **Units.** Users say "2000 watts", "2 kW", "4500" (meaning 4.5 kW). Pass what they said;
   `setup_system` and `add_appliance` normalise and tell you what they stored.
8. **Reports are history, forecasts are future.** `energy_report` is what happened; `power_status` and
   `can_i_run` are what will. Do not mix them in one sentence without saying which is which.
9. **Never invent a figure.** If a tool errors, say what failed in plain words and suggest
   asking again; do not fill the gap with a guess.

## Example

> **User:** Can I iron now?
> **Agent:** `can_i_run {appliance: "iron"}` → `{ok:false, minSocWithPct: 12, bestStartHour: 11}`
> **Agent:** Not now — ironing would take the battery to 12 %, under your 20 % reserve. Best time is around 09:00 tomorrow, when the sun will cover it. Want me to plan the day and remind you?

## Edge cases

- **No appliances yet** → `plan_day` returns a message inviting the user to add one; relay it.
- **Grid unknown** (`grid_available: null`, off-grid sites) → Powerline treats the grid as off; say "assuming no grid".
- **Stale reading** (`telemetry.source` ends with `(stale: …)`) → mention that the inverter has not reported recently.
- **Two households** share one server via different bearer tokens; you only ever see the one your session was opened with.
