-- ============================================================
-- BidVibe — Thêm loại giao dịch ví 'deposit_forfeit' (mất cọc).
-- Khi người thắng quá hạn thanh toán 24 giờ, cọc bị tịch thu; thay đổi
-- này vẫn phải có dòng trong wallet_transactions (xem README: không tự
-- cộng/trừ số dư mà không để lại dấu vết).
-- ============================================================

BEGIN;

DO $$
DECLARE
  con TEXT;
BEGIN
  SELECT conname INTO con
  FROM pg_constraint
  WHERE conrelid = 'wallet_transactions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%deposit_hold%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE wallet_transactions DROP CONSTRAINT %I', con);
  END IF;
END $$;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
  CHECK (kind IN ('topup', 'deposit_hold', 'deposit_release', 'deposit_forfeit', 'payment', 'refund'));

COMMIT;
