-- ============================================================
-- BidVibe — (BE1) 1) Đóng băng đồng hồ khi phiên bị tạm dừng.
--                 2) Một phiên không có hai cờ 'pending' cùng lý do.
-- Chỉ THÊM: một cột, một hàm + trigger, một index. Không đổi/xoá cấu trúc cũ.
-- Không tạo bảng mới nên không cần bật thêm RLS.
-- ============================================================

BEGIN;

-- ---------- 1) Tạm dừng đóng băng đồng hồ ----------
-- auctions.paused_at = lúc phiên bắt đầu bị tạm dừng (NULL = không tạm dừng).
-- Ai đổi flagged_auctions.status sang/khỏi 'paused' (Admin của BE2, hay bất kỳ ai)
-- thì trigger tự ghi/thanh toán thời gian dừng, nên không phải sửa code nơi đổi cờ:
--   * có cờ 'paused'  -> ghi paused_at = lúc bắt đầu dừng
--   * hết cờ 'paused' -> ends_at += thời gian đã dừng, xoá paused_at
-- "Đang tạm dừng" = còn ít nhất một cờ 'paused' trên phiên.
ALTER TABLE auctions ADD COLUMN paused_at TIMESTAMPTZ;

CREATE FUNCTION sync_auction_pause() RETURNS trigger AS $$
DECLARE
  aid       BIGINT;
  cur       TIMESTAMPTZ;
  cur_state TEXT;
  is_paused BOOLEAN;
BEGIN
  FOR aid IN
    SELECT DISTINCT x
    FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.auction_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.auction_id END
    ]) AS x
    WHERE x IS NOT NULL
  LOOP
    -- Khoá dòng phiên: tuần tự với đặt giá / đóng phiên đang chạy.
    SELECT paused_at, status INTO cur, cur_state FROM auctions WHERE id = aid FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT EXISTS (
      SELECT 1 FROM flagged_auctions WHERE auction_id = aid AND status = 'paused'
    ) INTO is_paused;

    IF is_paused AND cur IS NULL AND cur_state = 'active' THEN
      UPDATE auctions SET paused_at = clock_timestamp() WHERE id = aid;
    ELSIF NOT is_paused AND cur IS NOT NULL THEN
      UPDATE auctions
      SET ends_at   = CASE WHEN status = 'active' THEN ends_at + (clock_timestamp() - cur) ELSE ends_at END,
          paused_at = NULL
      WHERE id = aid;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flagged_auctions_sync_pause
  AFTER INSERT OR DELETE OR UPDATE OF status, auction_id ON flagged_auctions
  FOR EACH ROW EXECUTE FUNCTION sync_auction_pause();

-- Phiên đang có cờ 'paused' từ trước migration: bắt đầu tính thời gian dừng từ bây giờ.
UPDATE auctions a
SET paused_at = clock_timestamp()
WHERE a.status = 'active' AND a.paused_at IS NULL
  AND EXISTS (SELECT 1 FROM flagged_auctions f WHERE f.auction_id = a.id AND f.status = 'paused');

-- ---------- 2) Chặn cờ 'pending' trùng ----------
-- Hai lượt giá đến cùng lúc cùng kích hoạt một luật gian lận: chỉ một cờ được tạo.
CREATE UNIQUE INDEX uq_flagged_auctions_pending_reason
  ON flagged_auctions (auction_id, reason)
  WHERE status = 'pending';

COMMIT;
