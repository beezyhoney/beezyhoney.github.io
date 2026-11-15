-- Beezy Honey admin portal: the whole D1 schema (one migration; nothing has been deployed yet).
--
-- Source: admin-portal-design.md §3.1 + §3.2, as changed by the owner's amendments:
--   A1 own email-code login (login_codes, admin_sessions, recovery_codes; admin_users holds HELPERS only,
--      owners come from the ADMIN_EMAILS secret and never have a row here),
--   A2 photos and backups in Workers KV (images.path is the KV key in MEDIA for uploads),
--   A3 stock pools (grams for honey, pieces for candles and sticks), harvests and batches,
--   approved extras: counters + orders.invoice_no, offer / gift / business settings, gift and bulk requests
--      (= orders with source 'gift' or is_bulk = 1, no separate table), test orders (A4 rehearsal).
--
-- Conventions (design §3):
-- - Money is INTEGER paise (₹310 = 31000).
-- - Times are TEXT UTC 'YYYY-MM-DDTHH:MM:SSZ' (so text order = time order); reports convert to IST with
--   '+330 minutes'. Dates are 'YYYY-MM-DD', months 'YYYY-MM'.
-- - Booleans are 0/1 with a CHECK. JSON columns have CHECK (json_valid(...)).
-- - Foreign keys are on (D1 always enforces them).
-- - Editable rows carry `version`: UPDATE … WHERE id = ? AND version = ?; 0 changes = "someone else changed this".
-- - No triggers. Every write is a guarded D1 batch (src/server/*.ts). Nothing is hard-deleted from the admin,
--   except "Clear test data" before go-live (A4).
-- - stock_moves and payments are append-only ledgers; stock_pools.on_hand and orders.paid_paise are caches
--   recomputed from them in the same batch, and a weekly reconcile job checks them.
-- - Later migrations are additive only (db/migrations/NNNN_*.sql), applied by hand before deploying code.
-- - D1 limits (stricter than plain SQLite, so the Node test shim does not catch them): a LIKE/GLOB pattern is at most
--   50 bytes ("LIKE or GLOB pattern too complex"), a compound SELECT has at most a few terms, 100 bound parameters.
--   Timestamps are therefore checked with strftime(…) IS value, not with one long GLOB.

-- ───────────────────────────── settings ─────────────────────────────
-- One row per key; value is JSON. Keys and defaults: src/server/settings.ts (seeded by db/seed.sql).
CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 40 AND key NOT GLOB '*[^a-z0-9_]*'),
  value TEXT NOT NULL CHECK (json_valid(value)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- ───────────────────────────── people and login (A1) ─────────────────────────────
-- Helpers only. Owners are the emails in the ADMIN_EMAILS secret (never stored in D1 or in the repo).
CREATE TABLE admin_users (
  email TEXT PRIMARY KEY CHECK (email = lower(trim(email)) AND instr(email, '@') > 1 AND length(email) <= 254),
  name TEXT CHECK (name IS NULL OR length(name) <= 60),
  role TEXT NOT NULL DEFAULT 'helper' CHECK (role = 'helper'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL,
  last_seen_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- 6-digit email codes. code_hash = HMAC-SHA256(LOGIN_SECRET, …) as hex; valid 10 minutes, single use,
-- at most 5 wrong tries (the login code in src/server/auth.ts enforces the limits).
CREATE TABLE login_codes (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL CHECK (email = lower(email)),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at TEXT,
  created_at TEXT NOT NULL,
  ip_hash TEXT
);
CREATE INDEX login_codes_email ON login_codes(email, created_at);
CREATE INDEX login_codes_expires ON login_codes(expires_at);

-- Sessions: the cookie holds 32 random bytes; only their HMAC is stored. 7 days absolute.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL CHECK (email = lower(email)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 300)
);
CREATE INDEX admin_sessions_email ON admin_sessions(email);
CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);

-- One-time recovery codes (8 per email), each can replace an email code once.
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL CHECK (email = lower(email)),
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX recovery_codes_email ON recovery_codes(email);

-- ───────────────────────────── photos (A2) ─────────────────────────────
-- path is the photo's name everywhere: relative to src/assets/img for repo photos ('murungai-main.jpg'),
-- and for uploads also the Workers KV key in MEDIA ('uploads/<ULID>.jpg', thumbnail 'uploads/thumbs/<ULID>.jpg').
-- public = 1 once a live, paused or retired product or a category uses it; only public uploads are served
-- on /media/uploads/… (drafts are previewed through the admin).
CREATE TABLE images (
  path TEXT PRIMARY KEY CHECK (
    length(path) BETWEEN 5 AND 200 AND substr(path, 1, 1) <> '/' AND path NOT GLOB '*..*' AND path NOT GLOB '*\*'
    AND (lower(path) GLOB '*.jpg' OR lower(path) GLOB '*.jpeg' OR lower(path) GLOB '*.png')),
  source TEXT NOT NULL CHECK (source IN ('repo', 'upload')),
  thumb_path TEXT CHECK (thumb_path IS NULL OR thumb_path GLOB 'uploads/thumbs/*'),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  bytes INTEGER CHECK (bytes IS NULL OR bytes > 0),
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  CHECK ((source = 'upload') = (path GLOB 'uploads/*')),
  CHECK ((source = 'upload') = (thumb_path IS NOT NULL))
);

-- ───────────────────────────── catalog ─────────────────────────────
CREATE TABLE categories (
  id TEXT PRIMARY KEY CHECK (id IN ('comb-honey', 'blossom-honey', 'wild-rare', 'from-the-hive')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  intro TEXT NOT NULL CHECK (length(intro) BETWEEN 1 AND 600),
  image TEXT NOT NULL REFERENCES images(path),
  is_honey INTEGER NOT NULL CHECK (is_honey IN (0, 1)),
  sort INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 60 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT GLOB '-*' AND slug NOT GLOB '*-'),        -- frozen once first_live_at is set (guarded UPDATE)
  short_code TEXT NOT NULL UNIQUE CHECK (length(short_code) BETWEEN 2 AND 4 AND short_code NOT GLOB '*[^A-Z]*'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'retired')),
  sort INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  category TEXT NOT NULL REFERENCES categories(id),
  kind TEXT NOT NULL DEFAULT '' CHECK (length(kind) <= 40),
  badge TEXT NOT NULL DEFAULT '' CHECK (length(badge) <= 40),
  with_comb INTEGER NOT NULL DEFAULT 0 CHECK (with_comb IN (0, 1)),
  tagline TEXT NOT NULL DEFAULT '' CHECK (length(tagline) <= 140),
  tone TEXT NOT NULL DEFAULT '#F4EBD6' CHECK (length(tone) = 7 AND substr(tone, 1, 1) = '#' AND substr(tone, 2) NOT GLOB '*[^0-9A-Fa-f]*'),
  photo TEXT REFERENCES images(path),                    -- main photo; required before going live
  card_photo TEXT REFERENCES images(path),               -- shop card photo, NULL = use photo
  specs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(specs_json) AND json_type(specs_json) = 'array'),
  colour_min INTEGER,
  colour_max INTEGER,
  about TEXT NOT NULL DEFAULT '',
  love_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(love_json) AND json_type(love_json) = 'array'),
  use_head TEXT CHECK (use_head IS NULL OR length(use_head) BETWEEN 1 AND 60),  -- NULL = "How to enjoy"
  use_text TEXT NOT NULL DEFAULT '',
  store_text TEXT NOT NULL DEFAULT '',
  finder_json TEXT CHECK (finder_json IS NULL OR json_valid(finder_json)),  -- {"taste":[…],"uses":[…],"rare":true?}
  bloom_json TEXT CHECK (bloom_json IS NULL OR json_valid(bloom_json)),     -- "all" | [months 1–12]
  bloom_note TEXT CHECK (bloom_note IS NULL OR length(bloom_note) BETWEEN 1 AND 200),
  in_gift_box INTEGER NOT NULL DEFAULT 0 CHECK (in_gift_box IN (0, 1)),
  first_live_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK ((colour_min IS NULL AND colour_max IS NULL) OR
         (colour_min BETWEEN 0 AND 6 AND colour_max BETWEEN colour_min AND 6)),
  CHECK (bloom_note IS NULL OR bloom_json IS NOT NULL),
  -- a product on the website (live, paused or retired) always has what the public catalog needs
  CHECK (status = 'draft' OR (photo IS NOT NULL AND length(trim(kind)) > 0 AND length(trim(badge)) > 0
    AND length(trim(tagline)) > 0 AND length(trim(about)) > 0 AND length(trim(use_text)) > 0
    AND length(trim(store_text)) > 0 AND first_live_at IS NOT NULL))
);
CREATE INDEX products_status_sort ON products(status, sort);

-- Gallery (photo slider); the caption is also the alt text, and the first one is the main photo's alt.
CREATE TABLE product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  image TEXT NOT NULL REFERENCES images(path),
  caption TEXT NOT NULL CHECK (length(caption) BETWEEN 3 AND 140),
  sort INTEGER NOT NULL,
  UNIQUE (product_id, image)
);
CREATE INDEX product_images_product ON product_images(product_id, sort);

-- Stock pools (A3): what the owner counts. One pool per honey product in grams (shown as kg); one pool per
-- candle size and one "Honey sticks" pool in pieces. on_hand is a cache of SUM(stock_moves.delta) and may be
-- negative. Tracking stays off ("In stock" on the site, no alerts) until the first harvest or count.
-- Counts are never published.
CREATE TABLE stock_pools (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 3 AND 80 AND code NOT GLOB '*[^a-z0-9:-]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  unit TEXT NOT NULL CHECK (unit IN ('g', 'piece')),
  sort INTEGER NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0, 1)),
  on_hand INTEGER NOT NULL DEFAULT 0,
  low_at INTEGER CHECK (low_at IS NULL OR low_at >= 0),   -- in the pool's unit; NULL = no "low" level
  availability TEXT NOT NULL DEFAULT 'auto' CHECK (availability IN ('auto', 'in', 'out')),  -- manual override
  tracking_since TEXT,                                     -- set when a harvest or count switches tracking on
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  UNIQUE (id, product_id)                                  -- target of the (pool, product) foreign keys below
);
CREATE INDEX stock_pools_product ON stock_pools(product_id, sort);

-- Packs. pool_qty = how much of the pool one pack uses: net grams for honey, pieces otherwise
-- ('Box of 10 (100 g)' uses 10 sticks). The composite foreign key keeps every pack on a pool of its own product.
CREATE TABLE variants (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT NOT NULL UNIQUE CHECK (code NOT GLOB '*[^a-z0-9:-]*' AND instr(code, ':') > 1),  -- never changes
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  sort INTEGER NOT NULL,
  net_grams INTEGER CHECK (net_grams IS NULL OR net_grams > 0),          -- ₹ per 100 g and kg sold
  pool_id INTEGER NOT NULL,
  pool_qty INTEGER NOT NULL CHECK (pool_qty > 0),
  price_paise INTEGER CHECK (price_paise IS NULL OR price_paise BETWEEN 100 AND 10000000),  -- NULL = price on WhatsApp
  mrp_paise INTEGER CHECK (mrp_paise IS NULL OR (price_paise IS NOT NULL AND mrp_paise >= price_paise)),  -- NULL = same as price
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  gift_ok INTEGER NOT NULL DEFAULT 0 CHECK (gift_ok IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  UNIQUE (product_id, label),
  FOREIGN KEY (pool_id, product_id) REFERENCES stock_pools(id, product_id)
);
CREATE INDEX variants_pool ON variants(pool_id);

CREATE TABLE price_history (
  id INTEGER PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  old_price_paise INTEGER,
  new_price_paise INTEGER,
  old_mrp_paise INTEGER,
  new_mrp_paise INTEGER,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 120),
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE INDEX price_history_variant ON price_history(variant_id, at);
CREATE INDEX price_history_at ON price_history(at);

-- ───────────────────────────── harvests and batches (A3) ─────────────────────────────
-- "Add harvest" is the main way stock goes in: one harvests row, one 'harvest' stock move and one batch.
-- There is deliberately no place column.
CREATE TABLE harvests (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  pool_id INTEGER NOT NULL,
  harvested_on TEXT NOT NULL CHECK (date(harvested_on) IS harvested_on),
  qty INTEGER NOT NULL CHECK (qty > 0),                  -- in the pool's unit: grams for honey
  hives INTEGER CHECK (hives IS NULL OR hives > 0),
  moisture_pct_x10 INTEGER CHECK (moisture_pct_x10 IS NULL OR moisture_pct_x10 BETWEEN 100 AND 300),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  idem_key TEXT NOT NULL UNIQUE,                         -- one form submit = one harvest
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  FOREIGN KEY (pool_id, product_id) REFERENCES stock_pools(id, product_id)
);
CREATE INDEX harvests_product ON harvests(product_id, harvested_on);

-- Batches for labels and the live Know Your Jar lookup. code_key = code in capitals without spaces or
-- punctuation (the rule of batchKey() in src/data/catalog.validate.mjs), unique.
CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 3 AND 24),
  code_key TEXT NOT NULL UNIQUE CHECK (length(code_key) >= 3 AND code_key NOT GLOB '*[^A-Z0-9]*'),
  product_id INTEGER NOT NULL REFERENCES products(id),
  harvest_id INTEGER REFERENCES harvests(id),
  harvested_label TEXT NOT NULL CHECK (length(harvested_label) BETWEEN 3 AND 40),  -- 'November 2026'
  packed_on TEXT NOT NULL CHECK (date(packed_on) IS packed_on),
  best_before TEXT NOT NULL CHECK (best_before GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND substr(best_before, 6, 2) BETWEEN '01' AND '12'),
  public_note TEXT CHECK (public_note IS NULL OR length(public_note) BETWEEN 1 AND 200),
  private_note TEXT CHECK (private_note IS NULL OR length(private_note) <= 500),
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),   -- "Show in Know Your Jar"
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'recalled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX batches_product ON batches(product_id, best_before);
CREATE INDEX batches_harvest ON batches(harvest_id) WHERE harvest_id IS NOT NULL;

-- The MRP printed on a batch's stickers, per pack (owner decision 16 Nov 2026: MRP goes on the batch stickers).
-- Saved from the Labels page, so a reprint of the batch prints the same MRP even after the catalog price changes.
-- No row = the label page suggests the pack's MRP (or price). The variant must belong to the batch's product.
CREATE TABLE batch_items (
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  label_mrp_paise INTEGER NOT NULL CHECK (label_mrp_paise BETWEEN 100 AND 10000000),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) IS updated_at),
  updated_by TEXT NOT NULL,
  PRIMARY KEY (batch_id, variant_id)
);

-- ───────────────────────────── orders ─────────────────────────────
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL CHECK (length(ref) = 8 AND substr(ref, 1, 3) = 'BZ-'
    AND substr(ref, 4) NOT GLOB '*[^346789ACDEFGHJKMNPQRTUVWXY]*'),  -- not unique by design
  client_key TEXT UNIQUE CHECK (client_key IS NULL OR (length(client_key) = 32 AND client_key NOT GLOB '*[^0-9a-f]*')),
  create_key TEXT UNIQUE CHECK (create_key IS NULL OR length(create_key) BETWEEN 8 AND 100),  -- admin form key: a double submit makes one order
  source TEXT NOT NULL CHECK (source IN ('cart', 'product', 'gift', 'manual', 'pasted')),
  channel TEXT NOT NULL DEFAULT 'website' CHECK (channel IN ('website', 'whatsapp', 'phone', 'in_person', 'other')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'spam')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),   -- rehearsal order (A4); never counts as a sale
  confirm_no INTEGER NOT NULL DEFAULT 0,                          -- +1 on every confirm (Undo → re-confirm)
  items_total_paise INTEGER NOT NULL DEFAULT 0 CHECK (items_total_paise >= 0),
  delivery_paise INTEGER NOT NULL DEFAULT 0 CHECK (delivery_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  total_paise INTEGER NOT NULL DEFAULT 0,
  paid_paise INTEGER NOT NULL DEFAULT 0,                          -- cache of SUM(payments.amount_paise)
  shown_total_paise INTEGER CHECK (shown_total_paise IS NULL OR shown_total_paise >= 0),  -- what the customer saw
  shown_live_version INTEGER,
  price_mismatch INTEGER NOT NULL DEFAULT 0 CHECK (price_mismatch IN (0, 1)),
  flags_json TEXT CHECK (flags_json IS NULL OR json_valid(flags_json)),  -- {"unknown":[…],"soldOut":[…]}
  gift_json TEXT CHECK (gift_json IS NULL OR json_valid(gift_json)),     -- {size,jar,picks,extras,boxes,occasion,neededBy,card}
  is_bulk INTEGER NOT NULL DEFAULT 0 CHECK (is_bulk IN (0, 1)),
  needed_by TEXT CHECK (needed_by IS NULL OR date(needed_by) IS needed_by),
  replied_at TEXT,
  customer_name TEXT CHECK (customer_name IS NULL OR length(customer_name) <= 80),   -- typed by the owner only
  customer_phone TEXT CHECK (customer_phone IS NULL OR length(customer_phone) <= 20),
  customer_address TEXT CHECK (customer_address IS NULL OR length(customer_address) <= 400),
  customer_city TEXT CHECK (customer_city IS NULL OR length(customer_city) <= 60),
  personal_cleared_at TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 200),
  invoice_no TEXT UNIQUE,                                         -- 'BZ/2026-27/0001', gapless per financial year
  invoiced_at TEXT,
  ip_hash TEXT,                                                   -- NULLed after 30 days
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,                                       -- 'public' until the owner first edits it
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  packed_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_op TEXT,                                                   -- op token of the last guarded batch
  CHECK (discount_paise <= items_total_paise),
  CHECK (total_paise = items_total_paise - discount_paise + delivery_paise),
  CHECK (status IN ('new', 'cancelled', 'spam') OR confirmed_at IS NOT NULL),
  CHECK (status NOT IN ('new', 'spam') OR confirmed_at IS NULL),
  CHECK ((source IN ('cart', 'product', 'gift')) = (client_key IS NOT NULL)),
  CHECK (create_key IS NULL OR source IN ('manual', 'pasted')),
  CHECK ((invoice_no IS NULL) = (invoiced_at IS NULL))
);
CREATE INDEX orders_status_created ON orders(status, created_at);
CREATE INDEX orders_confirmed ON orders(confirmed_at) WHERE confirmed_at IS NOT NULL;
CREATE INDEX orders_ref ON orders(ref);
CREATE INDEX orders_created ON orders(created_at);
CREATE INDEX orders_last_op ON orders(last_op);                   -- lines of an order made in the same batch find it
CREATE INDEX orders_requests ON orders(needed_by) WHERE source = 'gift' OR is_bulk = 1;

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'fee', 'custom')),
  variant_id INTEGER REFERENCES variants(id),
  product_id INTEGER REFERENCES products(id),
  name_snapshot TEXT NOT NULL CHECK (length(name_snapshot) BETWEEN 1 AND 120),
  pack_snapshot TEXT NOT NULL DEFAULT '' CHECK (length(pack_snapshot) <= 60),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 999),
  unit_price_paise INTEGER CHECK (unit_price_paise IS NULL OR unit_price_paise >= 0),  -- NULL = no price yet
  list_price_paise INTEGER,                         -- D1 price when the line was made
  net_grams INTEGER CHECK (net_grams IS NULL OR net_grams > 0),  -- pack net weight, copied at confirm (kg sold)
  price_note TEXT CHECK (price_note IS NULL OR length(price_note) <= 120),  -- reason for a price override
  line_total_paise INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  CHECK ((kind = 'item') = (variant_id IS NOT NULL)),
  CHECK (kind <> 'fee' OR product_id IS NULL),
  CHECK (line_total_paise = qty * COALESCE(unit_price_paise, 0))
);
CREATE UNIQUE INDEX order_lines_variant ON order_lines(order_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_product ON order_lines(product_id);

-- ───────────────────────────── stock ledger (A3) ─────────────────────────────
-- Append-only (no admin route updates or deletes it). delta is in the pool's unit.
-- idem_key forms: 'sale:<order>:<confirm_no>:<pool>' | 'rev:<sale move id>' | 'harvest:<harvest id>' |
--   'count:<op>:<pool>' | 'adj:<op>'. A duplicate key aborts the whole batch.
CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY,
  pool_id INTEGER NOT NULL REFERENCES stock_pools(id),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL CHECK (reason IN ('harvest', 'count', 'sale', 'sale_reversal', 'damage', 'sample', 'return', 'other')),
  order_id INTEGER REFERENCES orders(id),
  harvest_id INTEGER REFERENCES harvests(id),
  idem_key TEXT NOT NULL UNIQUE,
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  created_by TEXT NOT NULL,
  CHECK ((reason IN ('sale', 'sale_reversal')) = (order_id IS NOT NULL)),
  CHECK ((reason = 'harvest') = (harvest_id IS NOT NULL)),
  CHECK (reason NOT IN ('sale', 'damage', 'sample') OR delta < 0),
  CHECK (reason NOT IN ('sale_reversal', 'harvest', 'return') OR delta > 0)
);
CREATE INDEX stock_moves_pool ON stock_moves(pool_id, created_at);
CREATE INDEX stock_moves_order ON stock_moves(order_id) WHERE order_id IS NOT NULL;

-- ───────────────────────────── payments ─────────────────────────────
-- Append-only; a refund is a negative row. orders.paid_paise caches the sum.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  method TEXT NOT NULL CHECK (method IN ('upi', 'cash', 'bank', 'card', 'other')),
  reference TEXT CHECK (reference IS NULL OR length(reference) <= 60),
  received_on TEXT NOT NULL CHECK (date(received_on) IS received_on),
  idem_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  created_by TEXT NOT NULL
);
CREATE INDEX payments_order ON payments(order_id);
CREATE INDEX payments_received ON payments(received_on);

-- Invoice numbers and other gapless counters: name 'invoice:2026-27' → last number used.
CREATE TABLE counters (
  name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 40),
  value INTEGER NOT NULL CHECK (value >= 0)
);

-- ───────────────────────────── audit, publishing, jobs ─────────────────────────────
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', at) IS at),
  actor TEXT NOT NULL,                      -- admin email | 'public' | 'system'
  action TEXT NOT NULL,                     -- 'order.confirm', 'stock.count', …
  entity TEXT NOT NULL,                     -- 'order', 'pool', 'variant', 'settings', …
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) <= 500),   -- 'Murungai Honey 250 g price ₹310 → ₹330'
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json))
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id, at);
CREATE INDEX audit_at ON audit_log(at);

CREATE TABLE publishes (
  id INTEGER PRIMARY KEY,
  site_version INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) <= 200),
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  http_status INTEGER,
  build_uuid TEXT,
  already_queued INTEGER CHECK (already_queued IS NULL OR already_queued IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'live', 'failed')),
  live_at TEXT,
  error TEXT CHECK (error IS NULL OR length(error) <= 500)
);
CREATE INDEX publishes_requested ON publishes(requested_at);

-- Fixed-window counters: 'ip:<hash>:<YYYYMMDDHH>', 'day:<YYYYMMDD>', 'login:…'. Deleted after expires_at.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY CHECK (length(bucket) <= 200),
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at TEXT NOT NULL
);
CREATE INDEX rate_limits_expires ON rate_limits(expires_at);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL CHECK (job IN ('backup', 'publish', 'cleanup', 'reconcile')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
  cursor_json TEXT CHECK (cursor_json IS NULL OR json_valid(cursor_json)),
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
);
CREATE INDEX job_runs_job ON job_runs(job, started_at);
