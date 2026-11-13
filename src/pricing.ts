import { callPartner } from "./partner";
import { warn } from "./log";

// Prices come from the partner. If the partner does not answer within PARTNER_TIMEOUT_MS, the list price is used.
export async function priceFor(env: Env, sku: string, listPriceCents: number): Promise<{ cents: number; source: string }> {
  try {
    const res = await callPartner(env, `/v1/prices/${sku}`, {}, Number(env.PARTNER_TIMEOUT_MS) || 500);
    if (res.ok) return { cents: (await res.json<{ priceCents: number }>()).priceCents, source: "partner" };
    warn("pricing error, using list price", { sku, status: res.status });
  } catch (e) {
    warn("pricing timeout, using list price", { sku, error: String(e) });
  }
  return { cents: listPriceCents, source: "list" };
}
