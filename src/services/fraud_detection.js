// Phát hiện đặt giá đáng ngờ theo luật (rule-based), ghi vào flagged_auctions + flag_evidence
// để Admin xử lý (pause / terminate / verify / safe). Chỉ đọc dữ liệu của domain BE1.
const { pool } = require('../config/db');
const bidModel = require('../models/bid.model');

const BURST_WINDOW_MS = 60_000;
const BURST_COUNT = 5;
const PING_PONG_MIN_BIDS = 6;
const JUMP_MULTIPLIER = 3;
const NEW_ACCOUNT_MS = 10 * 60_000;

const fmt = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;

// Phân tích thuần trên danh sách lượt đặt giá (cũ -> mới) — dễ test, không đụng DB.
// bids: [{ bidderId, amount, at: Date, accountCreatedAt: Date }]
function analyze(bids, { startPrice = 0 } = {}) {
  const signals = [];
  if (bids.length < 2) return signals;

  // 1. Hai người đẩy giá qua lại: toàn bộ lượt gần đây chỉ của 2 tài khoản, xen kẽ.
  const recent = bids.slice(-8);
  const distinct = new Set(recent.map((b) => b.bidderId));
  if (recent.length >= PING_PONG_MIN_BIDS && distinct.size === 2) {
    const alternating = recent.every((b, i) => i === 0 || b.bidderId !== recent[i - 1].bidderId);
    if (alternating) {
      signals.push({
        code: 'ping_pong',
        severity: 'high',
        confidence: 85,
        reason: 'Chỉ hai tài khoản đặt giá xen kẽ nhau',
        explanation: `${recent.length} lượt gần nhất chỉ do 2 tài khoản đặt xen kẽ — dấu hiệu đẩy giá (shill bidding).`,
        evidence: [
          ['Số lượt xen kẽ', String(recent.length)],
          ['Số tài khoản tham gia (gần nhất)', '2'],
        ],
      });
    }
  }

  // 2. Dồn dập: một tài khoản đặt >= 5 lượt trong 60 giây.
  const last = bids[bids.length - 1];
  const burst = bids.filter(
    (b) => b.bidderId === last.bidderId && last.at - b.at <= BURST_WINDOW_MS,
  );
  if (burst.length >= BURST_COUNT) {
    signals.push({
      code: 'burst',
      severity: 'medium',
      confidence: 70,
      reason: 'Một tài khoản đặt giá dồn dập',
      explanation: `Một tài khoản đặt ${burst.length} lượt trong chưa đầy 60 giây — có thể là bot.`,
      evidence: [['Số lượt trong 60 giây', String(burst.length)]],
    });
  }

  // 3. Nhảy giá bất thường: giá mới >= 3 lần giá liền trước.
  const prev = bids[bids.length - 2];
  if (prev.amount > 0 && last.amount >= prev.amount * JUMP_MULTIPLIER) {
    signals.push({
      code: 'price_jump',
      severity: 'low',
      confidence: 55,
      reason: 'Giá tăng đột biến',
      explanation: `Lượt mới (${fmt(last.amount)}) gấp ${(last.amount / prev.amount).toFixed(1)} lần lượt liền trước (${fmt(prev.amount)}).`,
      evidence: [['Giá trước', fmt(prev.amount)], ['Giá mới', fmt(last.amount)]],
    });
  }

  // 4. Tài khoản mới tạo (< 10 phút) đã đặt giá cao hơn 2 lần giá khởi điểm.
  if (
    last.accountCreatedAt && last.at - last.accountCreatedAt < NEW_ACCOUNT_MS
    && startPrice > 0 && last.amount >= startPrice * 2
  ) {
    signals.push({
      code: 'new_account',
      severity: 'medium',
      confidence: 60,
      reason: 'Tài khoản mới tạo đặt giá cao',
      explanation: 'Tài khoản vừa tạo chưa đầy 10 phút đã đặt giá gấp đôi giá khởi điểm.',
      evidence: [['Tuổi tài khoản', `${Math.round((last.at - last.accountCreatedAt) / 60_000)} phút`]],
    });
  }

  return signals;
}

// Quét một phiên và ghi cờ cho tín hiệu chưa được ghi. Trả về số cờ mới.
async function scanAuction(auctionId) {
  const { rows } = await pool.query(
    `SELECT l.starting_price FROM auctions a JOIN listings l ON l.id = a.listing_id WHERE a.id = $1`,
    [auctionId],
  );
  if (!rows[0]) return 0;
  const bids = await bidModel.listRawByAuction(pool, auctionId);
  const signals = analyze(bids, { startPrice: Number(rows[0].starting_price) });

  let created = 0;
  for (const s of signals) {
    // Không tạo trùng: đã có cờ cùng lý do mà Admin chưa đánh dấu 'safe'.
    const dup = await pool.query(
      `SELECT 1 FROM flagged_auctions WHERE auction_id = $1 AND reason = $2 AND status <> 'safe'`,
      [auctionId, s.reason],
    );
    if (dup.rowCount > 0) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const f = await client.query(
        `INSERT INTO flagged_auctions (auction_id, severity, confidence, reason, ai_explanation)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [auctionId, s.severity, s.confidence, s.reason, s.explanation],
      );
      for (const [label, value] of s.evidence) {
        await client.query(
          'INSERT INTO flag_evidence (flagged_auction_id, label, value) VALUES ($1, $2, $3)',
          [f.rows[0].id, label, value],
        );
      }
      await client.query('COMMIT');
      created += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return created;
}

module.exports = { analyze, scanAuction };
