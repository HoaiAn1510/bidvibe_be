-- ============================================================
-- BidVibe — (BE1) Báo cho server biết khi phiên bị tạm dừng / tiếp tục, để đẩy
-- Socket.io `auction:update` tới người đang xem phiên.
-- Thay THÂN hàm sync_auction_pause() (tạo ở 006) để gọi pg_notify; trigger, cột,
-- index giữ nguyên. pg_notify chỉ được gửi đi khi giao dịch COMMIT (ROLLBACK thì
-- không gửi), nên server không bao giờ đẩy trạng thái chưa chốt.
-- Kênh: 'auction_pause', payload JSON { "auctionId": "<id>", "paused": true|false }.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION sync_auction_pause() RETURNS trigger AS $$
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
      PERFORM pg_notify('auction_pause', json_build_object('auctionId', aid::text, 'paused', true)::text);
    ELSIF NOT is_paused AND cur IS NOT NULL THEN
      UPDATE auctions
      SET ends_at   = CASE WHEN status = 'active' THEN ends_at + (clock_timestamp() - cur) ELSE ends_at END,
          paused_at = NULL
      WHERE id = aid;
      -- Phiên đã huỷ / kết thúc thì đã có `auction:ended`, không báo "tiếp tục".
      IF cur_state = 'active' THEN
        PERFORM pg_notify('auction_pause', json_build_object('auctionId', aid::text, 'paused', false)::text);
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;
