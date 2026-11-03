-- Một phiên có thể có đơn hết hạn rồi một đơn mời người trả giá cao thứ hai.
-- Chỉ một đơn chưa hết hạn được tồn tại cho mỗi phiên; dữ liệu cũ giữ nguyên.
BEGIN;

ALTER TABLE orders
  ADD COLUMN is_runner_up_offer BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE orders
  DROP CONSTRAINT orders_auction_id_key;

CREATE UNIQUE INDEX idx_orders_one_effective_per_auction
  ON orders (auction_id)
  WHERE payment_status <> 'expired';

COMMIT;
