/**
 * Process-wide configuration and the small time helpers every layer shares.
 * Anything that reads process.env more than once belongs here, so a value
 * can never be parsed two different ways in two files.
 */
import type { SystemProfile } from "./forecast.js";

const num = (v: string | undefined, fallback: number): number => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Household UTC offset in hours. Default +1 = Africa/Lagos. Per-household storage is the next step. */
export const TZ_OFFSET = num(process.env.TZ_OFFSET, 1);

/** Used until the household runs setup_system. */
export const DEFAULT_PROFILE: SystemProfile = { arrayKw: 4.5, batteryKwh: 10, inverterKw: 5, reserveSocPct: 20 };

/** 0–23 local hour for an ISO timestamp, applying TZ_OFFSET. NaN input → 0. */
export function localHourOf(iso: string, offset = TZ_OFFSET): number {
  const d = shifted(iso, offset);
  return d ? d.getUTCHours() : 0;
}
/** The instant moved by the offset so UTC getters read local time; half-hour zones (India, Adelaide) stay exact. */
function shifted(iso: string, offset: number): Date | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + (Number.isFinite(offset) ? offset : 0) * 3_600_000);
}

/** "HH:MM" local time for an ISO timestamp. */
export function localClock(iso: string, offset = TZ_OFFSET): string {
  const d = shifted(iso, offset);
  if (!d) return "--:--";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "HH:00" for an hour offset from a local base hour. */
export const hourLabel = (localHour: number, offsetHours: number): string => `${String((((Math.floor(localHour) + Math.floor(offsetHours)) % 24) + 24) % 24).padStart(2, "0")}:00`;

/** Why an appliance is safe to run now — shared by reminders and arming. */
export const reasonFor = (source: "solar" | "grid" | "battery"): string =>
  source === "solar" ? "the sun is covering it" : source === "grid" ? "grid power is on" : "the battery can take it";
