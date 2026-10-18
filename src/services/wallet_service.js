// Service ví — nơi DUY NHẤT được đổi wallet_balance / wallet_held (chỉ BE1 viết).
// Mọi hàm ghi nhận `client` đang trong giao dịch của nơi gọi (BEGIN ... COMMIT do
// nơi gọi quản lý) và luôn để lại một dòng wallet_transactions.
// BE2 muốn hoàn tiền (ví dụ Admin xử lý tranh chấp) thì gọi refund().
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const walletModel = require('../models/wallet.model');

const MAX_TOPUP = 100_000_000;

// Phạt người hay bỏ đơn: từ `minForfeits` lần bị tịch thu cọc (quá hạn thanh toán) trong `windowDays` ngày gần nhất thì
// không được đặt cọc tham gia phiên mới đến `blockDays` ngày sau lần tịch thu gần nhất. Chặn lặp lại việc cọc rồi bỏ đơn.
const JOIN_BLOCK = { minForfeits: 2, windowDays: 30, blockDays: 7 };

const insufficient = (need, have) => new AppError(
  `Số dư chưa đủ (cần thêm ${need - have} VND)`, 402, 'INSUFFICIENT_FUNDS',
);

// Thời điểm được tham gia phiên mới trở lại (Date), hoặc null nếu không bị chặn. Mốc thời gian lấy từ
// wallet_transactions loại 'deposit_forfeit' (created_at = lúc tịch thu): auction_deposits chỉ có created_at lúc đặt cọc
// nên không biết lúc tịch thu. Mọi so sánh theo giờ DATABASE.
async function joinBlockedUntil(executor, bidderId) {
  const { rows } = await (executor || pool).query(
    `SELECT count(*)::int AS n,
            max(created_at) + ($3 * interval '1 day') AS until,
            (max(created_at) + ($3 * interval '1 day')) > clock_timestamp() AS active
     FROM wallet_transactions
     WHERE bidder_id = $1 AND kind = 'deposit_forfeit'
       AND created_at > clock_timestamp() - ($2 * interval '1 day')`,
    [bidderId, JOIN_BLOCK.windowDays, JOIN_BLOCK.blockDays],
  );
  const r = rows[0];
  return r.n >= JOIN_BLOCK.minForfeits && r.active ? new Date(r.until) : null;
}

async function getWallet(bidderId) {
  const w = await walletModel.getBalances(pool, bidderId);
  if (!w) throw new AppError('Không tìm thấy ví của người mua', 404, 'NOT_FOUND');
  return { balance: w.balance, held: w.held, available: w.balance, joinBlockedUntil: await joinBlockedUntil(pool, bidderId) };
}

async function topUp(client, { bidderId, amount }) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_TOPUP) {
    throw new AppError(`Số tiền nạp phải từ 1 đến ${MAX_TOPUP} VND`, 400, 'VALIDATION_ERROR');
  }
  const w = await walletModel.adjust(client, bidderId, { balance: amount });
  if (!w) throw new AppError('Không tìm thấy ví của người mua', 404, 'NOT_FOUND');
  return walletModel.insertTx(client, { bidderId, kind: 'topup', amount, balanceAfter: w.balance });
}

// Giữ cọc: balance -> held.
async function holdDeposit(client, { bidderId, auctionId, amount }) {
  const w = await walletModel.adjust(client, bidderId, { balance: -amount, held: amount });
  if (!w) {
    const cur = await walletModel.getBalances(client, bidderId);
    throw insufficient(amount, cur ? cur.balance : 0);
  }
  return walletModel.insertTx(client, {
    bidderId, kind: 'deposit_hold', amount, auctionId, balanceAfter: w.balance,
  });
}

// Hoàn cọc: held -> balance.
async function releaseDeposit(client, { bidderId, auctionId, amount }) {
  const w = await walletModel.adjust(client, bidderId, { balance: amount, held: -amount });
  if (!w) throw new AppError('Ví không còn đủ tiền đang giữ để hoàn cọc', 500, 'WALLET_INCONSISTENT');
  return walletModel.insertTx(client, {
    bidderId, kind: 'deposit_release', amount, auctionId, balanceAfter: w.balance,
  });
}

// Tịch thu cọc (quá hạn thanh toán): held giảm, không hoàn về ví.
async function forfeitDeposit(client, { bidderId, auctionId, amount }) {
  const w = await walletModel.adjust(client, bidderId, { held: -amount });
  if (!w) throw new AppError('Ví không còn đủ tiền đang giữ để tịch thu cọc', 500, 'WALLET_INCONSISTENT');
  return walletModel.insertTx(client, {
    bidderId, kind: 'deposit_forfeit', amount, auctionId, balanceAfter: w.balance,
  });
}

// Thanh toán đơn thắng: cọc được trừ vào tổng tiền, phần còn lại trừ từ ví
// (viaWallet) hoặc coi như đã thu qua cổng ngoài (VietQR / thẻ — giả lập).
// Tiền nằm trong ký quỹ của nền tảng (orders.payout_status = 'pending') đến khi giải ngân.
async function payOrder(client, { bidderId, auctionId, totalDue, depositAmount, viaWallet }) {
  const remainder = Math.max(totalDue - depositAmount, 0);
  const w = await walletModel.adjust(client, bidderId, {
    balance: viaWallet ? -remainder : 0,
    held: -depositAmount,
  });
  if (!w) {
    const cur = await walletModel.getBalances(client, bidderId);
    throw insufficient(remainder, cur ? cur.balance : 0);
  }
  return walletModel.insertTx(client, {
    bidderId, kind: 'payment', amount: totalDue, auctionId, balanceAfter: w.balance,
  });
}

// Hoàn tiền về ví (BE2 gọi khi Admin xử lý tranh chấp = refund).
async function refund(client, { bidderId, amount, auctionId = null }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError('Số tiền hoàn phải là số nguyên dương', 400, 'VALIDATION_ERROR');
  }
  const w = await walletModel.adjust(client, bidderId, { balance: amount });
  if (!w) throw new AppError('Không tìm thấy ví của người mua', 404, 'NOT_FOUND');
  return walletModel.insertTx(client, {
    bidderId, kind: 'refund', amount, auctionId, balanceAfter: w.balance,
  });
}

module.exports = {
  JOIN_BLOCK, joinBlockedUntil, getWallet, topUp, holdDeposit, releaseDeposit, forfeitDeposit, payOrder, refund,
};
