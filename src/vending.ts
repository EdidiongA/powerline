/**
 * Prepaid electricity vending: verify a meter, buy units, get the token.
 *
 * Most Nigerian homes are on prepaid meters. When the plan leans on the grid and the units run
 * out, the grid is "on" and the house is still dark. Powerline knows when the grid will be needed,
 * so it can say how long the units will last and buy more, after the household says yes.
 *
 * One interface, two backends (the same pattern as the inverter adapters):
 *   UNITS_VENDOR=sim     (default) — a simulated vendor: deterministic tokens, no network, no money.
 *   UNITS_VENDOR=vtpass            — VTpass's bill-payment API. SANDBOX ONLY unless VTPASS_ALLOW_LIVE=1:
 *                                     a hackathon build must never move real money by accident.
 *                                     VTPASS_API_KEY, VTPASS_SECRET_KEY; VTPASS_BASE_URL to override.
 * VTpass sandbox: meter 1111111111111 verifies and vends successfully; any other number fails.
 */
import { createHash, randomBytes } from "node:crypto";

export interface MeterCheck { ok: boolean; customerName?: string; address?: string; minAmount?: number; error?: string }
export interface Vend {
  status: "delivered" | "pending" | "failed";
  token?: string;          // the 20-digit code the household types into the meter
  units?: number;          // kWh
  message?: string;        // the vendor's own words, for failures and pending
  vendorRef?: string;      // the vendor's transaction id
}
export interface VendRequest { ref: string; meter: string; disco: string; amount: number; phone?: string; ratePerKwh?: number }

export interface UnitsVendor {
  /** "simulated", "vtpass-sandbox" or "vtpass-live": shown in replies and /healthz so nobody mistakes one for another. */
  readonly name: string;
  readonly simulated: boolean;
  verify(meter: string, disco: string): Promise<MeterCheck>;
  buy(req: VendRequest): Promise<Vend>;
  /** Ask again about a purchase that came back pending. */
  requery(ref: string): Promise<Vend>;
}

/** Distribution companies (DisCos) and the VTpass service id for each. Aliases are what people actually say. */
export const DISCOS: Record<string, { name: string; serviceId: string; aliases: string[] }> = {
  ikeja: { name: "Ikeja Electric", serviceId: "ikeja-electric", aliases: ["ikeja", "ikedc", "ie", "ikeja electric"] },
  eko: { name: "Eko Electricity", serviceId: "eko-electric", aliases: ["eko", "ekedc", "eko electric", "eko electricity"] },
  abuja: { name: "Abuja Electricity", serviceId: "abuja-electric", aliases: ["abuja", "aedc"] },
  kano: { name: "Kano Electricity", serviceId: "kano-electric", aliases: ["kano", "kedco"] },
  portharcourt: { name: "Port Harcourt Electricity", serviceId: "portharcourt-electric", aliases: ["port harcourt", "portharcourt", "phed", "ph"] },
  jos: { name: "Jos Electricity", serviceId: "jos-electric", aliases: ["jos", "jed"] },
  kaduna: { name: "Kaduna Electric", serviceId: "kaduna-electric", aliases: ["kaduna", "kaedco"] },
  enugu: { name: "Enugu Electricity", serviceId: "enugu-electric", aliases: ["enugu", "eedc"] },
  ibadan: { name: "Ibadan Electricity", serviceId: "ibadan-electric", aliases: ["ibadan", "ibedc"] },
  benin: { name: "Benin Electricity", serviceId: "benin-electric", aliases: ["benin", "bedc"] },
  aba: { name: "Aba Power", serviceId: "aba-electric", aliases: ["aba", "aba power"] },
  yola: { name: "Yola Electricity", serviceId: "yola-electric", aliases: ["yola", "yedc"] },
};

/** "IKEDC", "Ikeja Electric", "ikeja-electric" → "ikeja"; unknown → null. */
export function discoKey(s: string): string | null {
  const t = s.toLowerCase().replace(/[-_.,]/g, " ").replace(/\s+/g, " ").trim().replace(/\s+(plc|disco|distribution company)$/, "").replace(/\s+distribution company$/, "").trim();
  for (const [key, d] of Object.entries(DISCOS)) {
    const forms = [key, ...d.aliases, d.serviceId.replace("-", " "), d.name.toLowerCase()];
    if (forms.includes(t) || forms.includes(t.replace(/\s+electric(ity)?$/, ""))) return key;
  }
  return null;
}

/** Meter numbers are 11 (prepaid, older) to 13 digits; spaces and dashes are how people read them out. */
export const normalizeMeter = (s: string): string | null => { const d = s.replace(/[\s-]/g, ""); return /^\d{11,13}$/.test(d) ? d : null; };

/** "1111 1111 1111 1" → "…1111": a meter number is not a secret, but a reply read aloud does not need all of it. */
export const maskMeter = (m: string): string => `…${m.slice(-4)}`;

/** VTpass request ids: the first 12 characters are YYYYMMDDHHII in Africa/Lagos time (UTC+1, no DST), then anything alphanumeric. */
export function newRequestId(now = new Date()): string {
  const l = new Date(now.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${l.getUTCFullYear()}${p(l.getUTCMonth() + 1)}${p(l.getUTCDate())}${p(l.getUTCHours())}${p(l.getUTCMinutes())}pl${randomBytes(6).toString("hex")}`;
}

/** 20 digits shown the way meters print them: 1234-5678-9012-3456-7890. */
export const formatToken = (t: string): string => { const d = t.replace(/\D/g, ""); return d.length === 20 ? d.replace(/(\d{4})(?=\d)/g, "$1-") : t; };

/** Units a payment buys after 7.5 % VAT, at the household's tariff. */
export const unitsFor = (amount: number, ratePerKwh: number): number => Math.round((amount / 1.075 / ratePerKwh) * 10) / 10;

// ---------------------------------------------------------------- simulated

export class SimulatedVendor implements UnitsVendor {
  readonly name = "simulated";
  readonly simulated = true;
  private readonly sold = new Map<string, Vend>();
  constructor(private readonly defaultRate = 225) {}
  async verify(meter: string, disco: string): Promise<MeterCheck> {
    if (!DISCOS[disco]) return { ok: false, error: `Unknown distribution company "${disco}".` };
    // Mirrors the sandbox's behaviour of a meter that does not exist, so the failure path can be shown too.
    if (/^0+$/.test(meter) || meter.startsWith("0000")) return { ok: false, error: "Meter not found on the distribution company's records." };
    return { ok: true, customerName: "Simulated customer", address: `${DISCOS[disco].name} service area`, minAmount: 500 };
  }
  async buy(req: VendRequest): Promise<Vend> {
    const done = this.sold.get(req.ref);
    if (done) return done; // the same reference never vends twice
    const check = await this.verify(req.meter, req.disco);
    if (!check.ok) return { status: "failed", message: check.error };
    // Deterministic per reference, so a test can predict it and a replay returns the same code.
    const digits = BigInt(`0x${createHash("sha256").update(`powerline:${req.ref}`).digest("hex").slice(0, 20)}`).toString().padStart(20, "0").slice(-20);
    const v: Vend = { status: "delivered", token: digits, units: unitsFor(req.amount, req.ratePerKwh ?? this.defaultRate), vendorRef: `SIM-${req.ref.slice(-8)}` };
    this.sold.set(req.ref, v);
    return v;
  }
  async requery(ref: string): Promise<Vend> {
    return this.sold.get(ref) ?? { status: "failed", message: "No such transaction." };
  }
}

// ---------------------------------------------------------------- VTpass

export const VTPASS_SANDBOX = "https://sandbox.vtpass.com/api";
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface VtResponse {
  code?: string;
  response_description?: string;
  content?: { Customer_Name?: string; Address?: string; Min_Purchase_Amount?: number | string; WrongBillersCode?: boolean; error?: string; transactions?: { status?: string; transactionId?: string } };
  token?: string; Token?: string; purchased_code?: string; mainToken?: string;
  units?: string | number; Units?: string | number; mainTokenUnits?: string | number;
}

export class VtpassVendor implements UnitsVendor {
  readonly simulated = false;
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; secretKey: string; baseUrl?: string; fetch?: Fetch; timeoutMs?: number }) {
    this.name = this.base === VTPASS_SANDBOX ? "vtpass-sandbox" : "vtpass-live";
  }
  private get base() { return (this.opts.baseUrl ?? VTPASS_SANDBOX).replace(/\/+$/, ""); }

  private async post(path: string, body: Record<string, unknown>): Promise<VtResponse> {
    const f = this.opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    const res = await f(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": this.opts.apiKey, "secret-key": this.opts.secretKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let json: VtResponse;
    try { json = JSON.parse(text) as VtResponse; } catch { throw new Error(`VTpass answered HTTP ${res.status} with something that is not JSON`); }
    if (!res.ok && !json.code) throw new Error(`VTpass answered HTTP ${res.status}`);
    return json;
  }

  async verify(meter: string, disco: string): Promise<MeterCheck> {
    const d = DISCOS[disco];
    if (!d) return { ok: false, error: `Unknown distribution company "${disco}".` };
    const r = await this.post("/merchant-verify", { billersCode: meter, serviceID: d.serviceId, type: "prepaid" });
    const c = r.content ?? {};
    if (r.code !== "000" || c.WrongBillersCode || c.error || !c.Customer_Name) {
      return { ok: false, error: c.error ?? r.response_description ?? "The meter could not be verified." };
    }
    const min = Number(c.Min_Purchase_Amount);
    return { ok: true, customerName: String(c.Customer_Name).trim(), address: c.Address ? String(c.Address).trim() : undefined, minAmount: Number.isFinite(min) && min > 0 ? min : undefined };
  }

  /** The first 20-digit token in a field ("Token : 2636 2054 4059 8275 7802 : 11.4kWh" → 26362054405982757802), never digits glued from other numbers. */
  static tokenOf(v: unknown): string | undefined {
    if (typeof v === "number" && !Number.isSafeInteger(v)) return undefined; // a 20-digit number has already lost digits
    if (typeof v !== "string" && typeof v !== "number") return undefined;
    // Runs of digit groups separated by single spaces or dashes; the token is consecutive groups adding up to exactly 20 digits.
    for (const m of String(v).matchAll(/\d+(?:[ -]\d+)*/g)) {
      const groups = m[0].split(/[ -]/);
      for (let i = 0; i < groups.length; i++) {
        let d = "";
        for (let j = i; j < groups.length && d.length < 20; j++) d += groups[j];
        if (d.length === 20) return d;
      }
    }
    return undefined;
  }

  /** VTpass puts the token and units in different fields per DisCo; take whichever is present. */
  private static parse(r: VtResponse): Vend {
    const status = String(r.content?.transactions?.status ?? "").toLowerCase();
    const token = [r.token, r.Token, r.mainToken, r.purchased_code].map(VtpassVendor.tokenOf).find(Boolean);
    // kWh only: tokenAmount is the naira value on some DisCos and must never be read as units.
    const unitsRaw = r.mainTokenUnits ?? r.units ?? r.Units;
    const units = Number(/[\d]+(?:\.\d+)?/.exec(String(unitsRaw ?? ""))?.[0] ?? Number.NaN);
    const vendorRef = r.content?.transactions?.transactionId;
    if (r.code === "000" && status === "delivered") return { status: "delivered", token, units: Number.isFinite(units) && units > 0 ? units : undefined, vendorRef };
    // 099 = still processing; "pending"/"initiated" = accepted, not yet vended. Either way the money may have moved: ask again, never re-buy.
    if (r.code === "099" || status === "pending" || status === "initiated") return { status: "pending", message: r.response_description ?? "Processing", vendorRef };
    return { status: "failed", message: r.response_description ?? "The purchase failed.", vendorRef };
  }

  async buy(req: VendRequest): Promise<Vend> {
    const d = DISCOS[req.disco];
    if (!d) return { status: "failed", message: `Unknown distribution company "${req.disco}".` };
    try {
      return VtpassVendor.parse(await this.post("/pay", {
        request_id: req.ref, serviceID: d.serviceId, billersCode: req.meter, variation_code: "prepaid", amount: req.amount, phone: req.phone ?? "08011111111",
      }));
    } catch (e) {
      // A timeout or a dropped connection after the request left: the vend may or may not have happened.
      // Report pending so the caller requeries with the same reference instead of buying again.
      return { status: "pending", message: `No clear answer from VTpass (${(e as Error).message}); checking again will settle it.` };
    }
  }

  async requery(ref: string): Promise<Vend> {
    return VtpassVendor.parse(await this.post("/requery", { request_id: ref }));
  }
}

/** The vendor this process uses, from the environment. Refuses a live endpoint unless explicitly allowed. */
export function vendorFromEnv(env: NodeJS.ProcessEnv = process.env): UnitsVendor {
  const choice = (env.UNITS_VENDOR ?? "sim").trim().toLowerCase();
  if (choice === "vtpass") {
    const apiKey = env.VTPASS_API_KEY?.trim(), secretKey = env.VTPASS_SECRET_KEY?.trim();
    const baseUrl = (env.VTPASS_BASE_URL?.trim() || VTPASS_SANDBOX).replace(/\/+$/, "");
    if (!apiKey || !secretKey) { console.error("[units] UNITS_VENDOR=vtpass needs VTPASS_API_KEY and VTPASS_SECRET_KEY; using the simulated vendor"); return new SimulatedVendor(); }
    if (baseUrl !== VTPASS_SANDBOX && env.VTPASS_ALLOW_LIVE !== "1") { console.error(`[units] VTPASS_BASE_URL is not the sandbox; set VTPASS_ALLOW_LIVE=1 to spend real money. Using the simulated vendor`); return new SimulatedVendor(); }
    return new VtpassVendor({ apiKey, secretKey, baseUrl });
  }
  if (choice !== "sim" && choice !== "simulated") console.error(`[units] unknown UNITS_VENDOR="${env.UNITS_VENDOR}"; using the simulated vendor`);
  return new SimulatedVendor();
}
