import { callPartner } from "./partner";
import { priceFor } from "./pricing";
import { log, warn } from "./log";

type Product = { sku: string; list_price_cents: number; stock: number };
export type Result = { status: number; body: Record<string, unknown> };

export async function checkout(env: Env, input: unknown): Promise<Result> {
  const { sku, qty } = (input ?? {}) as { sku?: unknown; qty?: unknown };
  if (typeof sku !== "string" || !Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > 5)
    return { status: 400, body: { error: "sku and qty (1-5) required" } };
  const n = qty as number;
  const product = await env.DB.prepare("SELECT sku, list_price_cents, stock FROM products WHERE sku = ?").bind(sku).first<Product>();
  if (!product) return { status: 404, body: { error: "unknown sku" } };

  const gate = env.GATE.getByName("checkout");
  await gate.acquire(Number(env.CHECKOUT_CONCURRENCY) || 8);
  try {
    const price = await priceFor(env, sku, product.list_price_cents);
    const reserved = await env.DB.prepare("UPDATE products SET stock = stock - ? WHERE sku = ? AND stock >= ?")
      .bind(n, sku, n)
      .run();
    if (reserved.meta.changes === 0) return { status: 409, body: { error: "out of stock" } };

    const id = crypto.randomUUID();
    const amount = price.cents * n;
    await env.DB.prepare("INSERT INTO orders (id, sku, qty, amount_cents, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .bind(id, sku, n, amount, Date.now())
      .run();
    const charge = await callPartner(env, "/v1/charges", { method: "POST", body: JSON.stringify({ orderId: id, amountCents: amount }) }, 5000);
    if (!charge.ok) {
      await env.DB.batch([
        env.DB.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").bind(id),
        env.DB.prepare("UPDATE products SET stock = stock + ? WHERE sku = ?").bind(n, sku),
      ]);
      warn("charge failed", { id, status: charge.status });
      return { status: 502, body: { error: "payment failed" } };
    }
    await env.DB.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").bind(id).run();
    await env.NOTIFY.send({ orderId: id });
    log("order paid", { id, sku, qty: n, amount, priceSource: price.source });
    return { status: 201, body: { id, status: "paid", amountCents: amount, priceSource: price.source } };
  } finally {
    await gate.release();
  }
}
