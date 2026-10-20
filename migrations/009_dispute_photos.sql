-- ============================================================
-- BidVibe — Ảnh bằng chứng cho tranh chấp.
-- dispute_photos: mỗi dòng là một ảnh gắn với một tranh chấp. url là URL public của bucket Storage của backend
-- (đã kiểm tra khi nhận, xem upload_service.pathFromPublicUrl), nên chỉ lưu URL, không lưu file trong database.
--   uploaded_by_kind / uploaded_by_id   ai tải: 'account' = accounts.id (người mua, người bán),
--                                       'ops' = ops_accounts.id (kho). Hai bảng có dãy id riêng nên phải kèm loại,
--                                       và không đặt khoá ngoại (id trỏ tới một trong hai bảng).
--   uploader_role                       vai trò lúc tải: 'bidder' | 'seller' | 'warehouse' (Admin không thêm ảnh)
-- Ảnh được giữ lại làm bằng chứng kể cả khi tranh chấp đã xử lý; xoá tranh chấp (không xảy ra trong hệ thống) thì
-- ảnh bị xoá theo (ON DELETE CASCADE). Chỉ THÊM một bảng: không đổi hay xoá bảng / cột cũ.
-- ============================================================

BEGIN;

CREATE TABLE dispute_photos (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id       BIGINT      NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  url              TEXT        NOT NULL,
  uploaded_by_kind TEXT        NOT NULL CHECK (uploaded_by_kind IN ('account', 'ops')),
  uploaded_by_id   BIGINT      NOT NULL,
  uploader_role    TEXT        NOT NULL CHECK (uploader_role IN ('bidder', 'seller', 'warehouse')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dispute_photos_dispute ON dispute_photos(dispute_id, created_at);

-- Bật RLS như migration 002: không có policy nào nên mọi truy cập qua API công khai (PostgREST / Supabase client)
-- bị chặn; backend kết nối bằng chuỗi postgres (chủ bảng) vẫn bypass RLS.
ALTER TABLE dispute_photos ENABLE ROW LEVEL SECURITY;

COMMIT;
