-- ============================================================
-- BidVibe — Địa chỉ giao hàng của người mua.
-- Chỉ THÊM (database dùng chung): bảng addresses + cột orders.shipping_address_id.
--
-- Địa chỉ đã gắn vào đơn đã gửi đi phải giữ nguyên để không sai lịch sử giao hàng, nên:
--   - xoá là xoá mềm (deleted_at), dòng vẫn còn cho đơn cũ tham chiếu;
--   - sửa địa chỉ mà đơn đã gửi đang dùng thì backend tạo dòng mới thay vì sửa dòng cũ.
-- ============================================================

BEGIN;

CREATE TABLE addresses (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     BIGINT      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_name TEXT        NOT NULL,
  phone          TEXT        NOT NULL,
  address_line   TEXT        NOT NULL,   -- số nhà, tên đường
  ward           TEXT,                   -- phường / xã
  district       TEXT,                   -- quận / huyện (có nơi không còn cấp này)
  city           TEXT        NOT NULL,   -- tỉnh / thành phố
  is_default     BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX idx_addresses_account ON addresses(account_id) WHERE deleted_at IS NULL;
-- Mỗi tài khoản tối đa một địa chỉ mặc định (trong số chưa xoá).
CREATE UNIQUE INDEX ux_addresses_default ON addresses(account_id) WHERE is_default AND deleted_at IS NULL;

ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;

-- Nullable để không hỏng các đơn đã có.
ALTER TABLE orders ADD COLUMN shipping_address_id BIGINT REFERENCES addresses(id);
CREATE INDEX idx_orders_shipping_address ON orders(shipping_address_id);

COMMIT;
