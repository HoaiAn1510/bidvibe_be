-- ============================================================
-- BidVibe — Thêm mật khẩu cho tài khoản nội bộ (ops_accounts).
-- Cho phép Thẩm định / Kho vận / Admin đăng nhập bằng JWT tự ký,
-- cùng cơ chế với accounts.password_hash.
-- ============================================================

BEGIN;

ALTER TABLE ops_accounts ADD COLUMN password_hash TEXT;

-- RLS đã bật từ migration 002 (không có policy nào); thêm cột không
-- làm thay đổi cờ rowsecurity, giữ nguyên hành vi chặn API công khai.

COMMIT;
