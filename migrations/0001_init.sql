CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  list_price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL
);
INSERT INTO products (sku, name, list_price_cents, stock) VALUES
  ('SKU-1', 'Coffee beans 250 g', 1400, 100000),
  ('SKU-2', 'Coffee beans 500 g', 1425, 100000),
  ('SKU-3', 'Paper filters', 1450, 100000),
  ('LTD-1', 'Limited edition grinder', 4900, 10);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX orders_created ON orders (created_at);
