/**
 * Seed N days of plausible hourly history for a household (see seed.ts).
 *
 *   npm run seed:history                   # 7 days for the demo household
 *   SEED_DAYS=14 SEED_HOUSEHOLD=lagos-home npm run seed:history
 *   SEED_END=2026-10-01T20:00:00Z …        # end the history where a simulated clock starts
 *   STORE=dynamodb npm run seed:history    # same, into DynamoDB
 *
 * Reads .env first (like `npm run start:aws`), so STORE / DEMO_USER_ID / API_TOKENS line up with the server.
 */
try { (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(".env"); } catch { /* no .env: fine */ }
// Imported after the env is loaded: the store picks its backend from the environment at module init.
const { seedHousehold } = await import("./seed.js");
const { storeHealth } = await import("./store/index.js");

const days = Number(process.env.SEED_DAYS ?? 7);
const id = process.env.SEED_HOUSEHOLD ?? process.env.DEMO_USER_ID ?? "demo-household";
const n = await seedHousehold(id, days, process.env.SEED_END ?? new Date().toISOString(), { arrayKw: Number(process.env.SIM_ARRAY_KW ?? 4.5), batteryKwh: Number(process.env.SIM_BATTERY_KWH ?? 10) });
const health = await storeHealth();
console.log(`Seeded ${n} hourly samples (${days} days) for "${id}" into ${health.backend} — ${health.detail}`);
