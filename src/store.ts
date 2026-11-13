import { checkout } from "./orders";
import { log, warn } from "./log";
import { VND_PER_USD, confirmPayment, methods, startPayment, webhook } from "./payments";

// Web shop API (/api/*): live prices and stock, cart checkout and purchase status. Each cart line goes through the same
// checkout as POST /orders, so pricing, stock reservation, payment and the confirmation queue behave exactly as for API
// orders. Prices are integers in units of 100 VND. Stripe or PayPal payment (payments.ts) happens after the purchase is
// placed.

const CITIES = ["Hà Nội", "TP. Hồ Chí Minh", "Đà Nẵng", "Hải Phòng", "Cần Thơ", "Tỉnh, thành khác"];
const SHIPPING: Record<string, number> = { standard: 300, express: 500 };
const FREE_SHIPPING_FROM = 5000;
const NO_STORE = { "cache-control": "no-store" };

type Line = { sku: string; qty: number; color: string | null; size: string | null };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function storeApi(req: Request, env: Env, path: string): Promise<Response | null> {
  if (req.method === "GET" && path === "/api/catalog") return catalog(env);
  const hook = path.match(/^\/api\/webhooks\/(stripe|paypal)$/);
  if (req.method === "POST" && hook) return webhook(env, hook[1], req);
  const origin = new URL(req.url).origin;
  if (req.method === "POST" && path === "/api/checkout") return placeOrder(env, await req.json().catch(() => null), origin);
  const m = path.match(/^\/api\/purchases\/([0-9a-f-]{36})(\/pay|\/confirm)?$/);
  if (req.method === "GET" && m && !m[2]) return purchase(env, m[1]);
  if (req.method === "POST" && m?.[2] === "/pay") {
    const r = await startPayment(env, m[1], origin);
    return "url" in r ? json(r) : json({ error: r.error }, r.status);
  }
  if (req.method === "POST" && m?.[2] === "/confirm") {
    const r = await confirmPayment(env, m[1]);
    return "error" in r ? json({ error: r.error }, r.status) : json(r);
  }
  return null;
}

async function catalog(env: Env): Promise<Response> {
  const { results: products } = await env.DB.prepare(
    "SELECT sku, name, list_price_cents AS price, stock FROM products ORDER BY sku",
  ).all();
  return json({ products, cities: CITIES, shipping: SHIPPING, freeShippingFrom: FREE_SHIPPING_FROM, payments: methods(env), vndPerUsd: VND_PER_USD });
}

async function placeOrder(env: Env, input: unknown, origin: string): Promise<Response> {
  const b = (input ?? {}) as Record<string, unknown>;
  const c = (b.customer ?? {}) as Record<string, unknown>;
  const customer = {
    name: str(c.name, 100),
    email: str(c.email, 200),
    phone: str(c.phone, 30).replace(/[\s.()-]/g, ""),
    address: str(c.address, 300),
    city: str(c.city, 50),
    note: str(c.note, 300),
  };
  const fields: Record<string, string> = {};
  if (!customer.name) fields.name = "Nhập họ tên người nhận.";
  if (!/^\+?[0-9]{9,15}$/.test(customer.phone)) fields.phone = "Số điện thoại gồm 9 đến 15 chữ số.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) fields.email = "Nhập email theo dạng ten@vidu.com.";
  if (!CITIES.includes(customer.city)) fields.city = "Chọn tỉnh, thành phố.";
  if (!customer.address) fields.address = "Nhập địa chỉ nhận hàng.";
  const shipping = typeof b.shipping === "string" && b.shipping in SHIPPING ? b.shipping : "";
  if (!shipping) fields.shipping = "Chọn cách giao hàng.";
  const payment = typeof b.payment === "string" && methods(env).includes(b.payment) ? b.payment : "";
  if (!payment) fields.payment = "Chọn phương thức thanh toán.";

  const lines: Line[] = [];
  for (const raw of Array.isArray(b.items) ? b.items.slice(0, 10) : []) {
    const it = (raw ?? {}) as Record<string, unknown>;
    if (typeof it.sku !== "string" || !Number.isInteger(it.qty) || (it.qty as number) < 1 || (it.qty as number) > 5) {
      fields.items = "Mỗi sản phẩm đặt từ 1 đến 5 chiếc.";
      break;
    }
    lines.push({ sku: it.sku, qty: it.qty as number, color: str(it.color, 40) || null, size: str(it.size, 20) || null });
  }
  if (!lines.length && !fields.items) fields.items = "Giỏ hàng đang trống.";
  if (Object.keys(fields).length) return json({ error: "invalid", fields }, 400);

  const known = await env.DB.prepare(
    "SELECT sku, list_price_cents FROM products WHERE sku IN (" + lines.map(() => "?").join(",") + ")",
  )
    .bind(...lines.map((l) => l.sku))
    .all<{ sku: string; list_price_cents: number }>();
  const prices = new Map(known.results.map((r) => [r.sku, r.list_price_cents]));
  if (lines.some((l) => !prices.has(l.sku))) return json({ error: "invalid", fields: { items: "Giỏ có sản phẩm không còn bán." } }, 400);
  const subtotal = lines.reduce((s, l) => s + (prices.get(l.sku) ?? 0) * l.qty, 0);
  const fee = shipping === "standard" && subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING[shipping];

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO purchases (id, name, email, phone, address, city, note, shipping, shipping_fee, payment, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)",
  )
    .bind(id, customer.name, customer.email, customer.phone, customer.address, customer.city, customer.note || null, shipping, fee, payment, Date.now())
    .run();

  let paid = 0;
  for (const [i, line] of lines.entries()) {
    let status = "failed";
    let orderId: string | null = null;
    let error: string | null = null;
    try {
      const res = await checkout(env, { sku: line.sku, qty: line.qty });
      if (res.status === 201) {
        status = "paid";
        orderId = String(res.body.id);
        paid++;
      } else {
        status = res.status === 409 ? "out_of_stock" : "failed";
        error = String(res.body.error ?? res.status);
      }
    } catch (e) {
      error = String(e);
      warn("web purchase line failed", { id, sku: line.sku, error });
    }
    await env.DB.prepare(
      "INSERT INTO purchase_items (purchase_id, line, sku, color, size, qty, order_id, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, i, line.sku, line.color, line.size, line.qty, orderId, status, error)
      .run();
  }
  const status = paid === lines.length ? "confirmed" : paid ? "partial" : "failed";
  await env.DB.prepare("UPDATE purchases SET status = ? WHERE id = ?").bind(status, id).run();
  log("web purchase", { id, lines: lines.length, paid, status });
  // Online payment: send the customer to the provider. If the provider is down, the order page offers to retry.
  const pay = paid && payment !== "cod" ? await startPayment(env, id, origin) : null;
  return json({ id, status, payUrl: pay && "url" in pay ? pay.url : undefined }, paid ? 201 : 409);
}

async function purchase(env: Env, id: string): Promise<Response> {
  const p = await env.DB.prepare(
    "SELECT id, name, phone, address, city, note, shipping, shipping_fee, payment, status, created_at, pay_status, pay_amount, pay_currency, paid_at " +
      "FROM purchases WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!p) return json({ error: "not found" }, 404);
  const { results } = await env.DB.prepare(
    "SELECT i.line, i.sku, i.color, i.size, i.qty, i.status, p.name, o.amount_cents, o.notified_at " +
      "FROM purchase_items i JOIN products p ON p.sku = i.sku LEFT JOIN orders o ON o.id = i.order_id " +
      "WHERE i.purchase_id = ? ORDER BY i.line",
  )
    .bind(id)
    .all();
  return json({ ...p, items: results });
}

