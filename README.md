# demo-shop

Order service and web shop ("NẾP") on Cloudflare Workers. Customers order products from the web shop or the API
(`POST /orders`); the service prices the order with the
partner pricing API (falls back to the list price after `PARTNER_TIMEOUT_MS`), reserves stock, charges the order through
the partner payment API, and queues an order confirmation that a queue consumer sends through the partner notification
API.

| Path | What it is |
|---|---|
| `src/index.ts` | HTTP routes and the queue handler |
| `src/orders.ts` | Checkout: stock reservation, payment, order rows |
| `src/store.ts` | Web shop API: `GET /api/catalog` (live prices and stock), `POST /api/checkout` (one checkout per cart line), `GET /api/purchases/:id` |
| `src/payments.ts` | Online payment of web purchases after checkout: Stripe Checkout or PayPal (sandbox accounts), `POST /api/purchases/:id/pay` and `/confirm`, provider webhooks `POST /api/webhooks/stripe` and `/paypal`; never used by `POST /orders` |
| `src/pricing.ts` | Partner pricing with list-price fallback |
| `src/notifications.ts` | Queue consumer that sends order confirmations |
| `src/gate.ts` | Durable Object limiting concurrent checkouts (`CHECKOUT_CONCURRENCY`) |
| `src/partner.ts` | Partner API client |
| `public/` | Web shop pages, scripts, fonts and product photos served as static assets (a generated static build; not edited by hand) |
| `migrations/` | D1 schema (`products`, `orders`, `purchases` with payment columns, `purchase_items`); prices are integers in units of 100 VND |
| `wrangler.jsonc` | Bindings and runtime configuration (`vars`) |
| `releases/` | Configuration of each release |

## Operations

- **Deploy:** push to `main`. The pipeline type-checks, applies D1 migrations and deploys (`.github/workflows/deploy.yml`).
- **Health:** `GET /health`, `GET /version` (deployed commit), `GET /products`.
- **Logs:** structured JSON (`msg`, `level`, fields); `npx wrangler tail demo-shop` streams them live.
- **Database:** `npx wrangler d1 execute demo-shop --remote --command "SELECT ..."`.
- **Configuration:** `vars` in `wrangler.jsonc`; record each change as a new file in `releases/`.
- **Partner API:** operated by another company, outside this repository. It may be slow or rate-limit requests
  (HTTP 429 with `Retry-After`).
