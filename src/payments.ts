import { log, warn } from "./log";

// Online payment of web purchases through Stripe Checkout or PayPal (sandbox accounts, test money only).
// A purchase is placed first exactly like cash on delivery (one checkout() per cart line); the customer then pays the
// purchase total on the provider's page and comes back to the order page, which asks the server to confirm. The server
// only trusts the provider's answer for the session or order id it stored itself. Checkout and POST /orders never call
// this module.
// Webhooks (POST /api/webhooks/stripe, /api/webhooks/paypal) cover customers who pay but never come back: after the
// signature check the event is only a nudge, and the shop asks the provider about its own stored id again.
// Secrets (optional; a method is offered only when its secrets are set): STRIPE_SECRET_KEY, PAYPAL_CLIENT_ID,
// PAYPAL_CLIENT_SECRET; for webhooks STRIPE_WEBHOOK_SECRET and PAYPAL_WEBHOOK_ID.

type PayEnv = Env &
  Partial<Record<"STRIPE_SECRET_KEY" | "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET" | "STRIPE_WEBHOOK_SECRET" | "PAYPAL_WEBHOOK_ID", string>>;
type Line = { qty: number; name: string; amount_cents: number };
type Purchase = { id: string; email: string; shipping: string; shipping_fee: number; payment: string; pay_status: string | null; pay_ref: string | null };

const PAYPAL_API = "https://api-m.sandbox.paypal.com";
/** PayPal has no VND: PayPal purchases are charged in USD at this fixed demo rate. */
export const VND_PER_USD = 26000;
const TIMEOUT = 10_000;

export function methods(env: Env): string[] {
  const e = env as PayEnv;
  return ["cod", ...(e.STRIPE_SECRET_KEY ? ["stripe"] : []), ...(e.PAYPAL_CLIENT_ID && e.PAYPAL_CLIENT_SECRET ? ["paypal"] : [])];
}

async function load(env: Env, id: string) {
  const p = await env.DB.prepare("SELECT id, email, shipping, shipping_fee, payment, pay_status, pay_ref FROM purchases WHERE id = ?")
    .bind(id)
    .first<Purchase>();
  if (!p) return null;
  const { results: lines } = await env.DB.prepare(
    "SELECT i.qty, p.name, o.amount_cents FROM purchase_items i JOIN products p ON p.sku = i.sku JOIN orders o ON o.id = i.order_id " +
      "WHERE i.purchase_id = ? AND i.status = 'paid' ORDER BY i.line",
  )
    .bind(id)
    .all<Line>();
  return { p, lines };
}

/** Starts (or restarts) payment of a placed purchase; returns the provider page to send the customer to. */
export async function startPayment(env: Env, id: string, origin: string): Promise<{ url: string } | { error: string; status: number }> {
  const found = await load(env, id);
  if (!found) return { error: "not found", status: 404 };
  const { p, lines } = found;
  if (p.payment === "cod" || !methods(env).includes(p.payment)) return { error: "online payment not available for this purchase", status: 409 };
  // A customer who paid but never came back must not be charged twice: ask the provider about the previous attempt first.
  if (p.pay_status === "due") {
    const prev = await confirmPayment(env, id);
    if ("pay_status" in prev && prev.pay_status === "paid") return { error: "already paid", status: 409 };
  }
  if (p.pay_status === "paid") return { error: "already paid", status: 409 };
  if (!lines.length) return { error: "nothing to pay", status: 409 };
  const back = (result: string) => origin + "/don-hang?id=" + id + "&tt=" + result;
  const total = lines.reduce((s, l) => s + l.amount_cents, 0) + p.shipping_fee; // units of 100 VND
  const started = p.payment === "stripe" ? await stripeSession(env as PayEnv, p, lines, back) : await paypalOrder(env as PayEnv, p, total, back);
  if (!started) return { error: "payment provider error", status: 502 };
  await env.DB.prepare("UPDATE purchases SET pay_status = 'due', pay_ref = ?, pay_amount = ?, pay_currency = ? WHERE id = ?")
    .bind(started.ref, started.amount, started.currency, id)
    .run();
  log("payment started", { id, provider: p.payment, amount: started.amount, currency: started.currency });
  return { url: started.url };
}

/** Asks the provider whether the stored session or order has been paid, and records it. */
export async function confirmPayment(env: Env, id: string): Promise<{ pay_status: string | null; declined?: boolean } | { error: string; status: number }> {
  const p = await env.DB.prepare("SELECT payment, pay_status, pay_ref FROM purchases WHERE id = ?")
    .bind(id)
    .first<{ payment: string; pay_status: string | null; pay_ref: string | null }>();
  if (!p) return { error: "not found", status: 404 };
  if (p.pay_status !== "due" || !p.pay_ref) return { pay_status: p.pay_status };
  const result = p.payment === "stripe" ? await stripePaid(env as PayEnv, p.pay_ref) : p.payment === "paypal" ? await paypalCapture(env as PayEnv, p.pay_ref) : "due";
  if (result !== "paid") return { pay_status: "due", declined: result === "declined" };
  await env.DB.prepare("UPDATE purchases SET pay_status = 'paid', paid_at = ? WHERE id = ? AND pay_status = 'due'").bind(Date.now(), id).run();
  log("payment confirmed", { id, provider: p.payment });
  return { pay_status: "paid" };
}

async function call(provider: string, url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) warn("payment provider error", { provider, status: res.status, error: body.error?.message ?? body.details?.[0]?.issue ?? body.name ?? body.error });
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    warn("payment provider unreachable", { provider, error: String(e) });
    return { ok: false, status: 0, body: {} as Record<string, any> };
  }
}

// ----- Stripe Checkout (hosted page; VND is a zero-decimal currency, so amounts are whole đồng) -----
async function stripeSession(env: PayEnv, p: Purchase, lines: Line[], back: (r: string) => string) {
  const f = new URLSearchParams({
    mode: "payment",
    success_url: back("xong"),
    cancel_url: back("huy"),
    client_reference_id: p.id,
    customer_email: p.email,
    locale: "vi",
    "metadata[purchase_id]": p.id,
  });
  const items = lines.map((l) => ({ name: l.name, unit: Math.round((l.amount_cents * 100) / l.qty), qty: l.qty }));
  if (p.shipping_fee) items.push({ name: p.shipping === "express" ? "Phí giao nhanh" : "Phí giao tiêu chuẩn", unit: p.shipping_fee * 100, qty: 1 });
  items.forEach((it, k) => {
    f.set("line_items[" + k + "][price_data][currency]", "vnd");
    f.set("line_items[" + k + "][price_data][product_data][name]", it.name);
    f.set("line_items[" + k + "][price_data][unit_amount]", String(it.unit));
    f.set("line_items[" + k + "][quantity]", String(it.qty));
  });
  const r = await call("stripe", "https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: f,
  });
  if (!r.ok || !r.body.url) return null;
  return { ref: String(r.body.id), url: String(r.body.url), amount: Number(r.body.amount_total), currency: "vnd" };
}

async function stripePaid(env: PayEnv, session: string) {
  const r = await call("stripe", "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(session), {
    headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY },
  });
  return r.ok && r.body.payment_status === "paid" ? "paid" : "due";
}

// ----- PayPal Orders v2 (approval page, then capture on return) -----
async function paypalToken(env: PayEnv) {
  const r = await call("paypal", PAYPAL_API + "/v1/oauth2/token", {
    method: "POST",
    headers: { authorization: "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET), "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  return r.ok ? String(r.body.access_token) : null;
}

async function paypalOrder(env: PayEnv, p: Purchase, total: number, back: (r: string) => string) {
  const token = await paypalToken(env);
  if (!token) return null;
  const cents = Math.ceil((total * 100 * 100) / VND_PER_USD);
  const r = await call("paypal", PAYPAL_API + "/v2/checkout/orders", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: p.id, custom_id: p.id, description: "NEP order " + p.id.slice(0, 8).toUpperCase(), amount: { currency_code: "USD", value: (cents / 100).toFixed(2) } }],
      payment_source: { paypal: { experience_context: { brand_name: "NEP", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: back("xong"), cancel_url: back("huy") } } },
    }),
  });
  const url = (r.body.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "payer-action")?.href;
  if (!r.ok || !url) return null;
  return { ref: String(r.body.id), url, amount: cents, currency: "usd" };
}

/** paid, declined (PayPal refused the card or account the buyer approved with: they must pay again) or due. */
async function paypalCapture(env: PayEnv, order: string): Promise<"paid" | "declined" | "due"> {
  const token = await paypalToken(env);
  if (!token) return "due";
  const url = PAYPAL_API + "/v2/checkout/orders/" + encodeURIComponent(order);
  const r = await call("paypal", url + "/capture", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" } });
  if (r.ok) return r.body.status === "COMPLETED" ? "paid" : "due";
  const issue = r.body.details?.[0]?.issue;
  if (issue === "INSTRUMENT_DECLINED") return "declined";
  // Already captured (the customer reloaded the page): read the order instead.
  if (issue === "ORDER_ALREADY_CAPTURED") {
    const g = await call("paypal", url, { headers: { authorization: "Bearer " + token } });
    return g.ok && g.body.status === "COMPLETED" ? "paid" : "due";
  }
  return "due";
}

// ----- Webhooks -----
export async function webhook(env: Env, provider: string, req: Request): Promise<Response> {
  const e = env as PayEnv;
  const raw = await req.text();
  const signed = provider === "stripe"
    ? !!e.STRIPE_WEBHOOK_SECRET && (await stripeSigned(e.STRIPE_WEBHOOK_SECRET, raw, req.headers.get("stripe-signature")))
    : !!e.PAYPAL_WEBHOOK_ID && (await paypalSigned(e, raw, req.headers));
  if (!signed) {
    warn("payment webhook rejected", { provider });
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }
  const ev = JSON.parse(raw) as Record<string, any>;
  const type = String(ev.type ?? ev.event_type);
  // Stripe: the Checkout Session; PayPal: the order (approved) or the order a capture belongs to.
  const ref: string | undefined = provider === "stripe"
    ? (type.startsWith("checkout.session.") ? ev.data?.object?.id : undefined)
    : type === "CHECKOUT.ORDER.APPROVED" ? ev.resource?.id : ev.resource?.supplementary_data?.related_ids?.order_id;
  const p = ref ? await env.DB.prepare("SELECT id FROM purchases WHERE pay_ref = ?").bind(ref).first<{ id: string }>() : null;
  const result = p ? await confirmPayment(env, p.id) : null;
  log("payment webhook", { provider, type, id: p?.id ?? null, pay_status: result && "pay_status" in result ? result.pay_status : null });
  return Response.json({ received: true });
}

const enc = new TextEncoder();

/** Stripe-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "t.body">; accepted within 5 minutes. */
async function stripeSigned(secret: string, raw: string, header: string | null) {
  const parts = (header ?? "").split(",").map((kv) => kv.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")).map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = enc.encode(t + "." + raw);
  for (const s of sigs) {
    const bytes = new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
    if (await crypto.subtle.verify("HMAC", key, bytes, data)) return true;
  }
  return false;
}

/** PayPal checks its own signature: the event goes back byte for byte with the transmission headers. */
async function paypalSigned(env: PayEnv, raw: string, h: Headers) {
  const token = await paypalToken(env);
  if (!token || !raw.trim().startsWith("{")) return false;
  const field = (name: string) => JSON.stringify(h.get("paypal-" + name) ?? "");
  const body = '{"auth_algo":' + field("auth-algo") + ',"cert_url":' + field("cert-url") + ',"transmission_id":' + field("transmission-id") +
    ',"transmission_sig":' + field("transmission-sig") + ',"transmission_time":' + field("transmission-time") +
    ',"webhook_id":' + JSON.stringify(env.PAYPAL_WEBHOOK_ID) + ',"webhook_event":' + raw + "}";
  const r = await call("paypal", PAYPAL_API + "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body,
  });
  return r.ok && r.body.verification_status === "SUCCESS";
}
