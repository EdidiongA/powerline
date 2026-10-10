/**
 * Typical draws for common household appliances, so "add the iron" works without a
 * wattage and "can I run the kettle?" works before anything has been set up.
 * Figures are mid-range for the units sold in West African markets; the user's own
 * numbers always win (add_appliance with explicit watts overrides a preset).
 */
export interface Preset { watts: number; minutes: number; aliases: string[] }

export const PRESETS: Record<string, Preset> = {
  iron:              { watts: 1800, minutes: 30,  aliases: ["pressing iron", "steam iron", "electric iron"] },
  kettle:            { watts: 2000, minutes: 5,   aliases: ["electric kettle", "jug"] },
  "washing machine": { watts: 500,  minutes: 45,  aliases: ["washer", "washing"] },
  microwave:         { watts: 1200, minutes: 10,  aliases: ["micro wave"] },
  "water pump":      { watts: 750,  minutes: 60,  aliases: ["pump", "borehole pump", "surface pump", "pumping machine"] },
  "water heater":    { watts: 1500, minutes: 30,  aliases: ["heater", "geyser", "boiler"] },
  "air conditioner": { watts: 1200, minutes: 180, aliases: ["ac", "a/c", "aircon", "air con", "split unit"] },
  fridge:            { watts: 150,  minutes: 1440, aliases: ["refrigerator", "freezer", "deep freezer", "chest freezer"] },
  "rice cooker":     { watts: 700,  minutes: 30,  aliases: ["cooker"] },
  "hot plate":       { watts: 1500, minutes: 30,  aliases: ["hotplate", "electric stove", "induction cooker", "induction"] },
  blender:           { watts: 400,  minutes: 5,   aliases: [] },
  toaster:           { watts: 900,  minutes: 5,   aliases: ["sandwich maker"] },
  television:        { watts: 90,   minutes: 240, aliases: ["tv", "telly"] },
  fan:               { watts: 60,   minutes: 480, aliases: ["standing fan", "ceiling fan"] },
  "hair dryer":      { watts: 1200, minutes: 10,  aliases: ["dryer"] },
  vacuum:            { watts: 800,  minutes: 20,  aliases: ["vacuum cleaner", "hoover"] },
  dishwasher:        { watts: 1300, minutes: 90,  aliases: [] },
  "desktop computer":{ watts: 200,  minutes: 480, aliases: ["pc", "desktop", "computer"] },
  "laptop charger":  { watts: 65,   minutes: 120, aliases: ["laptop"] },
  "phone charger":   { watts: 10,   minutes: 120, aliases: ["phone"] },
};

// Articles are dropped only when they stand alone before another word, so "a/c" survives.
const norm = (s: string) => s.toLowerCase().replace(/\b(the|my|a|an)\s+(?=\S)/g, "").replace(/[^a-z/ ]/g, " ").replace(/\s+/g, " ").trim();

/** The preset for a name the user used, matching the canonical name or any alias; undefined when unknown. */
export function presetFor(name: string): (Preset & { canonical: string }) | undefined {
  const n = norm(name);
  if (!n) return undefined;
  for (const [canonical, p] of Object.entries(PRESETS)) {
    if (n === canonical || p.aliases.includes(n)) return { ...p, canonical };
  }
  // Loose: the user's phrase contains a known name ("the big iron", "kitchen kettle").
  for (const [canonical, p] of Object.entries(PRESETS)) {
    if ([canonical, ...p.aliases].some((k) => k.length >= 3 && new RegExp(`\\b${k.replace(/[/]/g, "\\/")}\\b`).test(n))) return { ...p, canonical };
  }
  return undefined;
}
