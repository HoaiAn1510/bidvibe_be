// Phát hiện đặt giá đáng ngờ theo luật (rule-based), ghi vào flagged_auctions + flag_evidence
// để Admin xử lý (pause / terminate / verify / safe). Chỉ đọc dữ liệu của domain BE1.
const { pool } = require('../config/db');
const bidModel = require('../models/bid.model');
// auction_engine chỉ require fraud_detection lười (trong setImmediate) nên không bị vòng phụ thuộc.
const { inTransaction } = require('./auction_engine');
const { AppError } = require('../middleware/errorHandler');

const BURST_WINDOW_MS = 60_000;
const BURST_COUNT = 5;
const PING_PONG_MIN_BIDS = 6;
const JUMP_MULTIPLIER = 3;
const NEW_ACCOUNT_MS = 10 * 60_000;

const fmt = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;

// ---- Luật theo danh tính người đặt giá (shill bidding) ----
// Luật seller_affinity: trong HISTORY_WINDOW_DAYS ngày gần nhất, một người mua đặt giá ở >= AFFINITY_MIN_AUCTIONS phiên
// khác nhau của CÙNG một người bán, các lượt đó chiếm >= AFFINITY_MIN_SHARE_PCT phần trăm tổng lượt giá của họ, và họ chưa
// từng thắng rồi thanh toán phiên nào của người bán này. Ba phiên là mức tối thiểu để loại trừ trùng hợp (ai đó thích hàng
// của một shop), 80 phần trăm để chỉ bắt người gần như CHỈ đặt giá ở một nơi; chưa từng mua thật thì mới đáng ngờ.
const HISTORY_WINDOW_DAYS = 30;
const AFFINITY_MIN_AUCTIONS = 3;
const AFFINITY_MIN_SHARE_PCT = 80;

// Chuẩn hoá số điện thoại để so sánh: bỏ khoảng trắng, dấu chấm, gạch, ngoặc; +84 / 0084 / 84 (11-12 chữ số) đổi thành 0.
// Số rỗng hoặc ngắn hơn 8 chữ số coi như không có (null) để hai số rỗng không bao giờ "trùng" nhau.
function normalizePhone(raw) {
  if (raw == null) return null;
  const compact = String(raw).replace(/[\s.\-()]/g, '');
  let digits = compact.replace(/\D/g, '');
  if (!digits) return null;
  if (compact.startsWith('+') && digits.startsWith('84')) digits = `0${digits.slice(2)}`;
  else if (digits.startsWith('0084')) digits = `0${digits.slice(4)}`;
  else if (/^84\d{9,10}$/.test(digits)) digits = `0${digits.slice(2)}`;
  return digits.length >= 8 ? digits : null;
}

// Che số trong bằng chứng: 0901234567 -> 090****567. Không bao giờ ghi đủ số.
const maskPhone = (phone) => (phone.length >= 8 ? `${phone.slice(0, 3)}****${phone.slice(-3)}` : '****');

const VN_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hourCycle: 'h23',
});
const fmtVn = (t) => {
  const p = Object.fromEntries(VN_TIME.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.day}/${p.month}/${p.year}`;
};

// Phân tích thuần trên danh sách lượt đặt giá (cũ -> mới) — dễ test, không đụng DB.
// bids: [{ bidderId, amount, at: Date, accountCreatedAt: Date }]
// context (scanAuction dựng bằng truy vấn gộp; bỏ trống thì chỉ chạy bốn luật theo mẫu lượt giá):
//   startPrice     giá khởi điểm
//   sellerPhone    số điện thoại của người bán (chưa chuẩn hoá)
//   bidderPhones   { [bidderId]: số điện thoại }
//   bidderHistory  { [bidderId]: { totalBids, sellerBids, sellerAuctions, paidWins, forfeits, lastForfeitAt } }
//                  totalBids / sellerBids: số lượt giá trong 30 ngày (mọi phiên / các phiên của người bán này);
//                  sellerAuctions: số phiên khác nhau của người bán này đã đặt giá trong 30 ngày;
//                  paidWins: số phiên của người bán này đã thắng và thanh toán (mọi thời gian);
//                  forfeits / lastForfeitAt: số lần bị tịch thu cọc trong 30 ngày và lần gần nhất.
function analyze(bids, context = {}) {
  return [...analyzePattern(bids, context), ...analyzeIdentity(bids, context)];
}

// Bốn luật theo mẫu lượt giá: ping_pong, burst, price_jump, new_account.
function analyzePattern(bids, { startPrice = 0 } = {}) {
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

// Ba luật theo danh tính người đặt giá. Chỉ xét những người đang đặt giá trong phiên này; mỗi luật tối đa một tín hiệu cho
// cả phiên (lý do cố định nên raiseFlag chống trùng cờ), bằng chứng liệt kê từng tài khoản vi phạm.
function analyzeIdentity(bids, { sellerPhone = null, bidderPhones = {}, bidderHistory = {} } = {}) {
  const signals = [];
  if (!bids.length) return signals;
  const bidders = [...new Set(bids.map((b) => b.bidderId))];
  const countIn = (id) => bids.filter((b) => b.bidderId === id).length;

  // Luật 1 — seller_alt_account: người đặt giá trùng số điện thoại với người bán (tài khoản phụ của người bán đẩy giá).
  const sellerP = normalizePhone(sellerPhone);
  if (sellerP) {
    const hits = bidders.filter((id) => normalizePhone(bidderPhones[id]) === sellerP);
    if (hits.length) {
      signals.push({
        code: 'seller_alt_account',
        severity: 'high',
        confidence: 90,
        reason: 'Người đặt giá trùng số điện thoại với người bán',
        explanation: `${hits.length} tài khoản đặt giá trong phiên có số điện thoại trùng với người bán — nghi người bán dùng tài khoản phụ để đẩy giá.`,
        evidence: hits.flatMap((id) => [
          [`Tài khoản #${id} · số điện thoại trùng (đã che)`, maskPhone(sellerP)],
          [`Tài khoản #${id} · số lượt giá trong phiên`, String(countIn(id))],
        ]),
      });
    }
  }

  // Luật 2 — seller_affinity: tài khoản gần như chỉ đặt giá phiên của một người bán, chưa từng mua thật của người đó.
  const affinity = bidders.filter((id) => {
    const h = bidderHistory[id];
    return h && h.totalBids > 0 && h.sellerAuctions >= AFFINITY_MIN_AUCTIONS
      && h.sellerBids * 100 >= h.totalBids * AFFINITY_MIN_SHARE_PCT && h.paidWins === 0;
  });
  if (affinity.length) {
    signals.push({
      code: 'seller_affinity',
      severity: 'medium',
      confidence: 70,
      reason: 'Tài khoản gần như chỉ đặt giá phiên của một người bán',
      explanation: `${affinity.length} tài khoản trong phiên gần như chỉ đặt giá phiên của người bán này và chưa từng mua thật — dấu hiệu đẩy giá có chủ đích.`,
      evidence: affinity.flatMap((id) => {
        const h = bidderHistory[id];
        return [
          [`Tài khoản #${id} · số phiên của người bán đã đặt giá (${HISTORY_WINDOW_DAYS} ngày)`, String(h.sellerAuctions)],
          [`Tài khoản #${id} · tỉ lệ lượt giá vào người bán này`, `${Math.round((h.sellerBids * 100) / h.totalBids)}% (${h.sellerBids}/${h.totalBids} lượt)`],
          [`Tài khoản #${id} · số phiên đã thắng và thanh toán`, String(h.paidWins)],
        ];
      }),
    });
  }

  // Luật 3 — repeat_forfeiter: người đang dẫn đầu từng thắng rồi bỏ không thanh toán (mất cọc).
  const leader = bids[bids.length - 1].bidderId;
  const lh = bidderHistory[leader];
  if (lh && lh.forfeits >= 1) {
    signals.push({
      code: 'repeat_forfeiter',
      severity: 'low',
      confidence: 60,
      reason: 'Người dẫn đầu từng thắng rồi bỏ không thanh toán',
      explanation: `Người đang dẫn đầu đã bị tịch thu cọc ${lh.forfeits} lần trong ${HISTORY_WINDOW_DAYS} ngày gần nhất vì không thanh toán — có thể lại bỏ đơn.`,
      evidence: [
        [`Tài khoản #${leader} · số lần bị tịch thu cọc (${HISTORY_WINDOW_DAYS} ngày)`, String(lh.forfeits)],
        ...(lh.lastForfeitAt ? [[`Tài khoản #${leader} · lần gần nhất (giờ Việt Nam)`, fmtVn(lh.lastForfeitAt)]] : []),
      ],
    });
  }

  return signals;
}

// Số điện thoại và lịch sử của MỌI người đặt giá trong phiên bằng hai truy vấn gộp (không truy vấn từng người).
async function loadIdentityContext(bids, sellerId) {
  const ids = [...new Set(bids.map((b) => b.bidderId))];
  if (!ids.length) return {};
  const [phones, hist] = await Promise.all([
    pool.query('SELECT id, phone FROM accounts WHERE id = ANY($1::bigint[])', [ids]),
    pool.query(
      `WITH recent AS (
         SELECT b.bidder_id, b.auction_id, l.seller_id
         FROM bids b JOIN auctions a ON a.id = b.auction_id JOIN listings l ON l.id = a.listing_id
         WHERE b.bidder_id = ANY($1::bigint[]) AND b.created_at > clock_timestamp() - ($3 * interval '1 day')
       )
       SELECT u.id AS bidder_id,
              (SELECT count(*) FROM recent r WHERE r.bidder_id = u.id)::int AS total_bids,
              (SELECT count(*) FROM recent r WHERE r.bidder_id = u.id AND r.seller_id = $2)::int AS seller_bids,
              (SELECT count(DISTINCT r.auction_id) FROM recent r WHERE r.bidder_id = u.id AND r.seller_id = $2)::int AS seller_auctions,
              (SELECT count(*) FROM orders o JOIN auctions a ON a.id = o.auction_id JOIN listings l ON l.id = a.listing_id
               WHERE o.bidder_id = u.id AND l.seller_id = $2 AND o.payment_status = 'paid')::int AS paid_wins,
              f.n AS forfeits, f.last_at AS last_forfeit_at
       FROM unnest($1::bigint[]) AS u(id)
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n, max(w.created_at) AS last_at FROM wallet_transactions w
         WHERE w.bidder_id = u.id AND w.kind = 'deposit_forfeit' AND w.created_at > clock_timestamp() - ($3 * interval '1 day')
       ) f ON true`,
      [ids, sellerId, HISTORY_WINDOW_DAYS],
    ),
  ]);
  const bidderPhones = {};
  for (const r of phones.rows) bidderPhones[String(r.id)] = r.phone;
  const bidderHistory = {};
  for (const r of hist.rows) {
    bidderHistory[String(r.bidder_id)] = {
      totalBids: r.total_bids,
      sellerBids: r.seller_bids,
      sellerAuctions: r.seller_auctions,
      paidWins: r.paid_wins,
      forfeits: r.forfeits,
      lastForfeitAt: r.last_forfeit_at ? new Date(r.last_forfeit_at) : null,
    };
  }
  return { bidderPhones, bidderHistory };
}

// Quét một phiên và ghi cờ cho tín hiệu chưa được ghi. Trả về số cờ mới.
async function scanAuction(auctionId) {
  const { rows } = await pool.query(
    `SELECT l.starting_price, l.seller_id, sa.phone AS seller_phone
     FROM auctions a JOIN listings l ON l.id = a.listing_id JOIN accounts sa ON sa.id = l.seller_id
     WHERE a.id = $1`,
    [auctionId],
  );
  if (!rows[0]) return 0;
  const bids = await bidModel.listRawByAuction(pool, auctionId);
  const identity = await loadIdentityContext(bids, rows[0].seller_id).catch((err) => {
    // Không dựng được ngữ cảnh danh tính thì bốn luật theo mẫu lượt giá vẫn chạy.
    console.error('[fraud] không dựng được ngữ cảnh danh tính:', err.message);
    return {};
  });
  const signals = analyze(bids, { startPrice: Number(rows[0].starting_price), sellerPhone: rows[0].seller_phone, ...identity });

  let created = 0;
  for (const s of signals) {
    // Kiểm tra trùng + ghi cờ nằm CHUNG một giao dịch, tuần tự theo phiên (xem raiseFlag).
    const flagId = await inTransaction((client) => raiseFlag(client, auctionId, s));
    if (flagId) created += 1;
  }
  return created;
}

// Khoá tư vấn (advisory) theo phiên, tự nhả khi COMMIT/ROLLBACK: mọi thao tác tạo cờ / thêm
// bằng chứng cho cùng một phiên chạy lần lượt, nên "kiểm tra rồi ghi" không bị chen ngang.
function lockFlags(client, auctionId) {
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`flags:${auctionId}`]);
}

// Ghi một cờ + bằng chứng trong giao dịch của nơi gọi. Trả về id cờ mới, hoặc null nếu đã có
// cờ cùng lý do (chưa bị Admin đánh dấu 'safe'). Chốt chặn thứ hai: unique index
// uq_flagged_auctions_pending_reason (migration 006) — một phiên không có hai cờ pending giống nhau.
async function raiseFlag(client, auctionId, s) {
  await lockFlags(client, auctionId);
  const dup = await client.query(
    `SELECT 1 FROM flagged_auctions WHERE auction_id = $1 AND reason = $2 AND status <> 'safe'`,
    [auctionId, s.reason],
  );
  if (dup.rowCount > 0) return null;

  const f = await client.query(
    `INSERT INTO flagged_auctions (auction_id, severity, confidence, reason, ai_explanation)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (auction_id, reason) WHERE status = 'pending' DO NOTHING
     RETURNING id`,
    [auctionId, s.severity, s.confidence, s.reason, s.explanation],
  );
  if (!f.rows[0]) return null;
  for (const [label, value] of s.evidence) {
    await client.query(
      'INSERT INTO flag_evidence (flagged_auction_id, label, value) VALUES ($1, $2, $3)',
      [f.rows[0].id, label, value],
    );
  }
  return f.rows[0].id;
}

// ---------- Người dùng báo cáo phiên đáng ngờ ----------

const REPORT_REASON = 'Người dùng báo cáo phiên đáng ngờ';
// Mỗi báo cáo là một dòng flag_evidence; nhãn chứa mã người báo cáo nên cũng là khoá chống báo trùng.
const reporterLabel = (accountId) => `Báo cáo từ người dùng #${accountId}`;

// Mỗi người báo cáo tối đa một lần mỗi phiên. Phiên đã có cờ 'pending' thì thêm bằng chứng vào
// cờ đó (ưu tiên cờ nghiêm trọng nhất), chưa có thì tạo cờ mới mức thấp để Admin xem xét.
// Trả về { reported: true, flagCreated }.
async function reportAuction({ reporterId, auctionId, reason, note = null }) {
  return inTransaction(async (client) => {
    const a = await client.query('SELECT 1 FROM auctions WHERE id = $1', [auctionId]);
    if (!a.rowCount) throw new AppError('Không tìm thấy phiên đấu giá', 404, 'NOT_FOUND');

    await lockFlags(client, auctionId); // hai báo cáo cùng lúc (kể cả của cùng một người) chạy lần lượt
    const label = reporterLabel(reporterId);
    const dup = await client.query(
      `SELECT 1 FROM flag_evidence e JOIN flagged_auctions f ON f.id = e.flagged_auction_id
       WHERE f.auction_id = $1 AND e.label = $2`,
      [auctionId, label],
    );
    if (dup.rowCount > 0) throw new AppError('Bạn đã báo cáo phiên này rồi', 409, 'ALREADY_REPORTED');

    const pending = await client.query(
      `SELECT id FROM flagged_auctions WHERE auction_id = $1 AND status = 'pending'
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id LIMIT 1`,
      [auctionId],
    );
    let flagId = pending.rows[0]?.id;
    let flagCreated = false;
    if (!flagId) {
      const f = await client.query(
        `INSERT INTO flagged_auctions (auction_id, severity, confidence, reason, ai_explanation)
         VALUES ($1, 'low', 30, $2, $3) RETURNING id`,
        [auctionId, REPORT_REASON, 'Có người dùng báo cáo phiên này; cần Admin xem xét thủ công.'],
      );
      flagId = f.rows[0].id;
      flagCreated = true;
    }
    await client.query(
      'INSERT INTO flag_evidence (flagged_auction_id, label, value) VALUES ($1, $2, $3)',
      [flagId, label, note ? `${reason} — ${note}` : reason],
    );
    return { reported: true, flagCreated };
  });
}

module.exports = { analyze, scanAuction, reportAuction, normalizePhone, maskPhone };
