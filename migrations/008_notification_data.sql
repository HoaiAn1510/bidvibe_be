-- ============================================================
-- BidVibe — (BE2) Dữ liệu điều hướng cho thông báo.
-- notifications.data: JSONB, NULL được phép (mặc định NULL). Chứa các id liên quan để app bấm
-- vào thông báo mở thẳng đúng màn: { "auctionId", "orderId", "listingId", "disputeId", "flagId" }
-- (chỉ khoá liên quan, giá trị là chuỗi id như API trả về). Quy ước đầy đủ: docs/api.md mục 15.
-- Chỉ THÊM một cột: thông báo cũ giữ data = NULL, RLS của bảng (migration 002) không đổi.
-- ============================================================

BEGIN;

ALTER TABLE notifications ADD COLUMN data JSONB;

COMMIT;
