-- ============================================================
-- BidVibe — Bật Row Level Security cho toàn bộ bảng nghiệp vụ.
-- Không tạo policy nào: mặc định RLS bật mà không có policy sẽ
-- chặn mọi truy cập qua API công khai (PostgREST/Supabase client).
-- Backend kết nối bằng chuỗi postgres (role postgres, chủ bảng)
-- vẫn bypass RLS như bình thường theo cơ chế của Postgres.
-- ============================================================

BEGIN;

ALTER TABLE accounts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_deposits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE auctions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bidders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispute_timeline     ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag_evidence        ENABLE ROW LEVEL SECURITY;
ALTER TABLE flagged_auctions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_photos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_accounts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sellers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_receipts   ENABLE ROW LEVEL SECURITY;

COMMIT;
