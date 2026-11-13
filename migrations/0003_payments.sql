-- Online payment of web purchases (Stripe Checkout or PayPal, sandbox accounts). purchases.payment: cod | stripe | paypal.
ALTER TABLE purchases ADD COLUMN pay_status TEXT;    -- NULL for cash on delivery; due | paid
ALTER TABLE purchases ADD COLUMN pay_ref TEXT;       -- Stripe Checkout Session id or PayPal order id
ALTER TABLE purchases ADD COLUMN pay_amount INTEGER; -- smallest unit of pay_currency (đồng for vnd, cents for usd)
ALTER TABLE purchases ADD COLUMN pay_currency TEXT;  -- vnd | usd
ALTER TABLE purchases ADD COLUMN paid_at INTEGER;
