const { pool } = require('../config/db');
const { maskName } = require('./auction.model');

async function insert(client, { auctionId, bidderId, amount }) {
  const { rows } = await client.query(
    `INSERT INTO bids (auction_id, bidder_id, amount) VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [auctionId, bidderId, amount],
  );
  return rows[0];
}

// Lượt đặt giá gần nhất của phiên (người dẫn đầu hiện tại).
async function findLatest(client, auctionId) {
  const { rows } = await client.query(
    'SELECT id, bidder_id, amount, created_at FROM bids WHERE auction_id = $1 ORDER BY id DESC LIMIT 1',
    [auctionId],
  );
  return rows[0] || null;
}

async function listByAuction(auctionId, { viewerId = null, limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT b.id, b.bidder_id, b.amount, b.created_at, ac.full_name
     FROM bids b JOIN accounts ac ON ac.id = b.bidder_id
     WHERE b.auction_id = $1
     ORDER BY b.id DESC
     LIMIT $2`,
    [auctionId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    who: maskName(r.full_name),
    amount: Number(r.amount),
    at: r.created_at,
    me: viewerId != null && String(r.bidder_id) === String(viewerId),
  }));
}

// Dữ liệu thô cho fraud_detection (không che tên, chỉ dùng phía server).
async function listRawByAuction(executor, auctionId, limit = 200) {
  const { rows } = await (executor || pool).query(
    `SELECT b.id, b.bidder_id, b.amount, b.created_at, ac.created_at AS account_created_at
     FROM bids b JOIN accounts ac ON ac.id = b.bidder_id
     WHERE b.auction_id = $1
     ORDER BY b.id DESC LIMIT $2`,
    [auctionId, limit],
  );
  return rows.reverse().map((r) => ({
    id: r.id,
    bidderId: String(r.bidder_id),
    amount: Number(r.amount),
    at: new Date(r.created_at),
    accountCreatedAt: new Date(r.account_created_at),
  }));
}

module.exports = { insert, findLatest, listByAuction, listRawByAuction };
