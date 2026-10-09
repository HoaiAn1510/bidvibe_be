const { pool } = require('../config/db');

const toTx = (r) => ({
  id: r.id,
  kind: r.kind,
  amount: Number(r.amount),
  relatedAuctionId: r.related_auction_id,
  balanceAfter: Number(r.balance_after),
  createdAt: r.created_at,
});

async function getBalances(executor, bidderId, { lock = false } = {}) {
  const { rows } = await (executor || pool).query(
    `SELECT wallet_balance, wallet_held FROM bidders WHERE account_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [bidderId],
  );
  if (!rows[0]) return null;
  return { balance: Number(rows[0].wallet_balance), held: Number(rows[0].wallet_held) };
}

// Cộng/trừ số dư bằng một câu lệnh nguyên tử. Điều kiện nằm trong WHERE (thay vì
// để CHECK >= 0 ném lỗi) để giao dịch của nơi gọi không bị Postgres đánh dấu hỏng.
// Trả về số dư mới, hoặc null nếu không có ví / không đủ tiền.
async function adjust(client, bidderId, { balance = 0, held = 0 }) {
  const { rows } = await client.query(
    `UPDATE bidders
     SET wallet_balance = wallet_balance + $2, wallet_held = wallet_held + $3
     WHERE account_id = $1
       AND wallet_balance + $2 >= 0 AND wallet_held + $3 >= 0
     RETURNING wallet_balance, wallet_held`,
    [bidderId, balance, held],
  );
  if (!rows[0]) return null;
  return { balance: Number(rows[0].wallet_balance), held: Number(rows[0].wallet_held) };
}

async function insertTx(client, { bidderId, kind, amount, auctionId = null, balanceAfter }) {
  const { rows } = await client.query(
    `INSERT INTO wallet_transactions (bidder_id, kind, amount, related_auction_id, balance_after)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, kind, amount, related_auction_id, balance_after, created_at`,
    [bidderId, kind, amount, auctionId, balanceAfter],
  );
  return toTx(rows[0]);
}

async function listTransactions(bidderId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT w.id, w.kind, w.amount, w.related_auction_id, w.balance_after, w.created_at,
            l.title AS auction_title
     FROM wallet_transactions w
     LEFT JOIN auctions a ON a.id = w.related_auction_id
     LEFT JOIN listings l ON l.id = a.listing_id
     WHERE w.bidder_id = $1
     ORDER BY w.created_at DESC, w.id DESC
     LIMIT $2 OFFSET $3`,
    [bidderId, limit, offset],
  );
  return rows.map((r) => ({ ...toTx(r), auctionTitle: r.auction_title }));
}

module.exports = { getBalances, adjust, insertTx, listTransactions };
