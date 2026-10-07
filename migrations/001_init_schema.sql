-- ============================================================
-- BidVibe — PostgreSQL schema (khớp ERD v5)
-- Tiền tệ: VND, lưu BIGINT (không có phần thập phân)
-- Thời gian: TIMESTAMPTZ
-- ============================================================

BEGIN;

-- ---------- Tài khoản ----------

CREATE TABLE accounts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name     TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT        NOT NULL,
  avatar_url    TEXT,
  status        TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bidders (
  account_id     BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  wallet_balance BIGINT NOT NULL DEFAULT 0 CHECK (wallet_balance >= 0),
  wallet_held    BIGINT NOT NULL DEFAULT 0 CHECK (wallet_held >= 0)
);

CREATE TABLE sellers (
  account_id BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  store_name TEXT,
  rating     NUMERIC(3,2) CHECK (rating BETWEEN 0 AND 5)
);

-- Một account chỉ được là bidder HOẶC seller, không cả hai.
CREATE FUNCTION enforce_single_role() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'bidders' AND EXISTS (SELECT 1 FROM sellers WHERE account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'Account % đã là seller', NEW.account_id;
  ELSIF TG_TABLE_NAME = 'sellers' AND EXISTS (SELECT 1 FROM bidders WHERE account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'Account % đã là bidder', NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bidders_single_role BEFORE INSERT ON bidders
  FOR EACH ROW EXECUTE FUNCTION enforce_single_role();
CREATE TRIGGER sellers_single_role BEFORE INSERT ON sellers
  FOR EACH ROW EXECUTE FUNCTION enforce_single_role();

-- Tài khoản nội bộ (Thẩm định / Kho vận / Admin), do Admin cấp.
CREATE TABLE ops_accounts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('appraiser', 'warehouse', 'admin')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  weekly_load INT  NOT NULL DEFAULT 0
);

-- ---------- Danh mục & tin đăng ----------

CREATE TABLE categories (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,   -- shoes, elec, antique
  name_vi TEXT NOT NULL
);

CREATE TABLE listings (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id          BIGINT NOT NULL REFERENCES sellers(account_id),
  category_id        BIGINT NOT NULL REFERENCES categories(id),
  title              TEXT   NOT NULL,
  description        TEXT,
  condition          TEXT,
  ai_suggested_price BIGINT CHECK (ai_suggested_price >= 0),
  starting_price     BIGINT NOT NULL CHECK (starting_price >= 0),
  duration_hours     INT    NOT NULL CHECK (duration_hours > 0),
  status             TEXT   NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'pending_appraisal', 'needs_info',
                                       'approved', 'rejected', 'live', 'ended', 'cancelled')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_listings_seller ON listings(seller_id);
CREATE INDEX idx_listings_status ON listings(status);

CREATE TABLE listing_photos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id  BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url         TEXT   NOT NULL,
  order_index INT    NOT NULL DEFAULT 0
);
CREATE INDEX idx_listing_photos_listing ON listing_photos(listing_id);

-- Nhiều dòng cho cùng một listing nếu có vòng "yêu cầu bổ sung" rồi nộp lại.
CREATE TABLE appraisals (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id   BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  appraiser_id BIGINT NOT NULL REFERENCES ops_accounts(id),
  decision     TEXT   NOT NULL CHECK (decision IN ('approve', 'reject', 'more_info')),
  reason       TEXT,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appraisals_listing ON appraisals(listing_id);

-- ---------- Phiên đấu giá ----------

CREATE TABLE auctions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id       BIGINT NOT NULL UNIQUE REFERENCES listings(id),
  current_price    BIGINT NOT NULL CHECK (current_price >= 0),
  bid_step         BIGINT NOT NULL CHECK (bid_step > 0),
  deposit_required BIGINT NOT NULL CHECK (deposit_required >= 0),  -- 10% giá khởi điểm
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  status           TEXT   NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'ended', 'cancelled')),
  winner_id        BIGINT REFERENCES bidders(account_id),
  bid_count        INT    NOT NULL DEFAULT 0,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_auctions_status_ends ON auctions(status, ends_at);

-- Cọc để được tham gia phiên (khác với lượt đặt giá).
CREATE TABLE auction_deposits (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auction_id BIGINT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id  BIGINT NOT NULL REFERENCES bidders(account_id),
  amount     BIGINT NOT NULL CHECK (amount > 0),
  status     TEXT   NOT NULL DEFAULT 'held'
             CHECK (status IN ('held', 'released', 'forfeited', 'applied_to_payment')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auction_id, bidder_id)   -- mỗi người cọc một lần cho mỗi phiên
);

CREATE TABLE bids (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auction_id BIGINT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id  BIGINT NOT NULL REFERENCES bidders(account_id),
  amount     BIGINT NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bids_auction_time ON bids(auction_id, created_at DESC);

-- ---------- Đơn hàng, kho, vận chuyển ----------

CREATE TABLE orders (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auction_id             BIGINT NOT NULL UNIQUE REFERENCES auctions(id),
  bidder_id              BIGINT NOT NULL REFERENCES bidders(account_id),
  seller_id              BIGINT NOT NULL REFERENCES sellers(account_id),
  final_price            BIGINT NOT NULL CHECK (final_price >= 0),
  payment_status         TEXT   NOT NULL DEFAULT 'awaiting_payment'
                         CHECK (payment_status IN ('awaiting_payment', 'paid', 'expired')),
  payment_deadline       TIMESTAMPTZ NOT NULL,          -- +24h kể từ lúc thắng
  delivered_confirmed_at TIMESTAMPTZ,
  payout_deadline        TIMESTAMPTZ,                   -- +72h sau khi giao, tự giải ngân
  payout_status          TEXT   NOT NULL DEFAULT 'pending'
                         CHECK (payout_status IN ('pending', 'released', 'disputed')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_bidder ON orders(bidder_id);
CREATE INDEX idx_orders_seller ON orders(seller_id);
CREATE INDEX idx_orders_payment_deadline ON orders(payment_deadline) WHERE payment_status = 'awaiting_payment';
CREATE INDEX idx_orders_payout_deadline  ON orders(payout_deadline)  WHERE payout_status = 'pending';

CREATE TABLE warehouse_receipts (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id          BIGINT NOT NULL UNIQUE REFERENCES orders(id),
  order_code        TEXT   NOT NULL,
  inspected_by      BIGINT REFERENCES ops_accounts(id),
  inspection_result TEXT   CHECK (inspection_result IN ('match', 'mismatch')),
  inspection_notes  TEXT,
  received_at       TIMESTAMPTZ
);

CREATE TABLE shipments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      BIGINT NOT NULL UNIQUE REFERENCES orders(id),
  status        TEXT   NOT NULL DEFAULT 'packing'
                CHECK (status IN ('packing', 'shipped', 'delivered')),
  tracking_code TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipment_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  step        TEXT   NOT NULL,
  note        TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_shipment_events_shipment ON shipment_events(shipment_id, at);

-- ---------- Ví ----------

CREATE TABLE wallet_transactions (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bidder_id          BIGINT NOT NULL REFERENCES bidders(account_id),
  kind               TEXT   NOT NULL
                     CHECK (kind IN ('topup', 'deposit_hold', 'deposit_release', 'payment', 'refund')),
  amount             BIGINT NOT NULL CHECK (amount > 0),
  related_auction_id BIGINT REFERENCES auctions(id),
  balance_after      BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wallet_tx_bidder ON wallet_transactions(bidder_id, created_at DESC);

-- ---------- Thông báo & chatbot ----------

CREATE TABLE notifications (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT  NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,   -- outbid, win, dispute, ...
  title      TEXT    NOT NULL,
  is_read    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_account ON notifications(account_id, created_at DESC);

CREATE TABLE chat_sessions (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sender     TEXT   NOT NULL CHECK (sender IN ('user', 'bot')),
  content    TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);

-- ---------- AI gắn cờ & tranh chấp ----------

CREATE TABLE flagged_auctions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auction_id     BIGINT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  severity       TEXT   NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  confidence     INT    NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  reason         TEXT,
  ai_explanation TEXT,
  status         TEXT   NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'paused', 'terminated', 'verify', 'safe'))
);
CREATE INDEX idx_flagged_auction ON flagged_auctions(auction_id);

CREATE TABLE flag_evidence (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flagged_auction_id BIGINT NOT NULL REFERENCES flagged_auctions(id) ON DELETE CASCADE,
  label              TEXT   NOT NULL,
  value              TEXT   NOT NULL
);

CREATE TABLE disputes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id),
  source        TEXT   NOT NULL CHECK (source IN ('bidder', 'seller', 'warehouse')),
  reporter_id   BIGINT REFERENCES accounts(id),   -- NULL khi nguồn là kho
  title         TEXT   NOT NULL,
  status        TEXT   NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  escrow_amount BIGINT NOT NULL DEFAULT 0 CHECK (escrow_amount >= 0),
  resolution    TEXT   NOT NULL DEFAULT 'none' CHECK (resolution IN ('refund', 'keep', 'none')),
  resolved_by   BIGINT REFERENCES ops_accounts(id)
);
CREATE INDEX idx_disputes_order  ON disputes(order_id);
CREATE INDEX idx_disputes_status ON disputes(status);

CREATE TABLE dispute_timeline (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id BIGINT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  note       TEXT   NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dispute_timeline_dispute ON dispute_timeline(dispute_id, at);

-- ---------- Dữ liệu danh mục ban đầu ----------

INSERT INTO categories (code, name_vi) VALUES
  ('shoes',   'Giày'),
  ('elec',    'Điện tử'),
  ('antique', 'Đồ cổ');

COMMIT;
