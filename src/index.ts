import { checkout } from "./orders";
import { deliver, type NotifyMessage } from "./notifications";
import { storeApi } from "./store";

export { CheckoutGate } from "./gate";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ status: "ok", version: env.BUILD_SHA });
      if (url.pathname === "/version") return json({ sha: env.BUILD_SHA });
      if (req.method === "POST" && url.pathname === "/orders") {
        const input = await req.json().catch(() => null);
        const res = await checkout(env, input);
        return json(res.body, res.status);
      }
      if (req.method === "GET" && url.pathname === "/products") {
        const { results } = await env.DB.prepare("SELECT sku, name, list_price_cents, stock FROM products ORDER BY sku").all();
        return json(results);
      }
      const order = url.pathname.match(/^\/orders\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && order) {
        const row = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(order[1]).first();
        return row ? json(row) : json({ error: "not found" }, 404);
      }
      if (url.pathname.startsWith("/api/")) {
        const res = await storeApi(req, env, url.pathname);
        if (res) return res;
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "unhandled", path: url.pathname, error: String(e) }));
      return json({ error: "internal error" }, 500);
    }
  },

  async queue(batch, env): Promise<void> {
    await deliver(batch, env);
  },
} satisfies ExportedHandler<Env, NotifyMessage>;
