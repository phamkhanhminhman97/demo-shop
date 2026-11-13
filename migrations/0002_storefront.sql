-- Storefront: web purchases (one purchase = one order per cart line, created through the same checkout as
-- POST /orders), confirmation delivery time on orders, and the shop's product names and prices.
-- Prices are integers in units of 100 VND (list_price_cents 2490 = 249.000 VND). Descriptions, photos, colours and
-- sizes live with the web pages (storefront source in the thesis repo); the database keeps what checkout needs.
ALTER TABLE orders ADD COLUMN notified_at INTEGER;

UPDATE products SET name = 'Áo thun cotton cổ tròn', list_price_cents = 2490 WHERE sku = 'SKU-1';
UPDATE products SET name = 'Váy lụa hai dây', list_price_cents = 3990 WHERE sku = 'SKU-2';
UPDATE products SET name = 'Chân váy mini lưng cao', list_price_cents = 2990 WHERE sku = 'SKU-3';
UPDATE products SET name = 'Áo trench dáng dài (bản giới hạn)', list_price_cents = 12900 WHERE sku = 'LTD-1';
INSERT INTO products (sku, name, list_price_cents, stock) VALUES
  ('SM-01', 'Sơ mi oversize', 4490, 100000),
  ('HD-01', 'Áo hoodie nỉ bông', 5990, 100000),
  ('JN-01', 'Quần jean ống rộng', 5490, 100000),
  ('TS-02', 'Áo ba lỗ len gân', 1990, 100000),
  ('DK-01', 'Áo len cổ lọ', 4990, 100000),
  ('VY-01', 'Đầm sơ mi dáng dài', 3990, 100000),
  ('QN-02', 'Quần ống suông', 4490, 100000),
  ('CP-01', 'Túi xách mini', 1990, 100000);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  note TEXT,
  shipping TEXT NOT NULL,        -- standard | express
  shipping_fee INTEGER NOT NULL,
  payment TEXT NOT NULL,         -- cod
  status TEXT NOT NULL,          -- confirmed | partial | failed
  created_at INTEGER NOT NULL
);
CREATE TABLE purchase_items (
  purchase_id TEXT NOT NULL,
  line INTEGER NOT NULL,
  sku TEXT NOT NULL,
  color TEXT,
  size TEXT,
  qty INTEGER NOT NULL,
  order_id TEXT,                 -- orders.id when the checkout succeeded
  status TEXT NOT NULL,          -- paid | out_of_stock | failed
  error TEXT,
  PRIMARY KEY (purchase_id, line)
);
