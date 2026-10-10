// Lõi đấu giá (BE1): tạo phiên, tham gia (cọc), đặt giá, đóng phiên, thanh toán, quá hạn.
// Mọi thao tác đụng tiền / nhiều bảng chạy trong MỘT giao dịch trên cùng một client;
// dòng `auctions` được khoá bằng SELECT ... FOR UPDATE để hai người không đặt trùng.
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const auctionModel = require('../models/auction.model');
const bidModel = require('../models/bid.model');
const walletService = require('./wallet_service');
const { createNotification, emitNotification } = require('./notification_service');
const registerSockets = require('../sockets');

const DEFAULT_BID_STEP = 50_000;
const SNIPE_WINDOW_MS = 30_000;       // đặt giá trong 30 giây cuối thì gia hạn thêm 30 giây
const PAYMENT_WINDOW_MS = 24 * 3600_000;
const FEE_RATE = 0.05;
const SHIPPING_FEE = 40_000;

const roundThousand = (n) => Math.round(n / 1000) * 1000;
const depositFor = (startPrice) => roundThousand(startPrice * 0.1);
const feeFor = (price) => roundThousand(price * FEE_RATE);

const fmt = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function emit(room, event, payload) {
  const io = registerSockets.getIo();
  if (io) io.to(room).emit(event, payload);
}

// ---------- Tạo phiên (BE2 gọi khi Thẩm định duyệt tin đăng) ----------

// `client` đang trong giao dịch của BE2. Sinh auctions (1-1 với listing), đặt listing = 'live'.
async function createAuctionForListing(client, listingId, { bidStep = DEFAULT_BID_STEP, startsAt = new Date() } = {}) {
  const { rows } = await client.query(
    'SELECT id, starting_price, duration_hours FROM listings WHERE id = $1 FOR UPDATE',
    [listingId],
  );
  const listing = rows[0];
  if (!listing) throw new AppError('Không tìm thấy tin đăng', 404, 'NOT_FOUND');

  const startPrice = Number(listing.starting_price);
  const endsAt = new Date(new Date(startsAt).getTime() + listing.duration_hours * 3600_000);
  let auctionId;
  try {
    auctionId = await auctionModel.insertAuction(client, {
      listingId,
      currentPrice: startPrice,
      bidStep,
      depositRequired: depositFor(startPrice),
      startsAt,
      endsAt,
    });
  } catch (err) {
    if (err.code === '23505') throw new AppError('Tin đăng này đã có phiên đấu giá', 409, 'AUCTION_EXISTS');
    throw err;
  }
  await client.query(`UPDATE listings SET status = 'live' WHERE id = $1`, [listingId]);
  return auctionId;
}

// ---------- Đọc ----------

async function listAuctions(filters) {
  return auctionModel.list(filters);
}

async function getAuction(auctionId, viewerId) {
  const auction = await auctionModel.findById(pool, auctionId, viewerId);
  if (!auction) throw new AppError('Không tìm thấy phiên đấu giá', 404, 'NOT_FOUND');
  const bids = await bidModel.listByAuction(auctionId, { viewerId, limit: 20 });
  return { ...auction, bids };
}

// ---------- Tham gia (đặt cọc) ----------

async function joinAuction({ bidderId, auctionId }) {
  return inTransaction(async (client) => {
    const a = await auctionModel.lockById(client, auctionId);
    if (!a) throw new AppError('Không tìm thấy phiên đấu giá', 404, 'NOT_FOUND');
    assertBiddable(a);

    const amount = Number(a.deposit_required);
    let deposit;
    try {
      deposit = await client.query(
        `INSERT INTO auction_deposits (auction_id, bidder_id, amount) VALUES ($1, $2, $3) RETURNING id`,
        [auctionId, bidderId, amount],
      );
    } catch (err) {
      if (err.code === '23505') throw new AppError('Bạn đã đặt cọc tham gia phiên này', 409, 'ALREADY_JOINED');
      throw err;
    }
    const tx = amount > 0
      ? await walletService.holdDeposit(client, { bidderId, auctionId, amount })
      : null;
    return { depositId: deposit.rows[0].id, deposit: amount, balanceAfter: tx ? tx.balanceAfter : null };
  });
}

function assertBiddable(a) {
  if (a.status !== 'active' || new Date(a.ends_at) <= new Date()) {
    throw new AppError('Phiên đấu giá đã kết thúc', 409, 'AUCTION_ENDED');
  }
  if (a.paused) throw new AppError('Phiên đang bị tạm dừng để kiểm tra', 409, 'AUCTION_PAUSED');
}

// ---------- Đặt giá ----------

// Truyền `amount` (giá tuyệt đối) HOẶC `increment` (cộng thêm vào giá hiện tại).
// Với `increment`, giá hiện tại được đọc SAU khi khoá dòng phiên, nên hai người đặt
// cùng lúc luôn nhận hai mức giá liên tiếp thay vì cùng đọc một giá cũ.
async function placeBid({ bidderId, auctionId, amount: requested, increment }) {
  const hasAmount = requested != null;
  const hasIncrement = increment != null;
  if (hasAmount === hasIncrement) {
    throw new AppError('Chỉ truyền một trong hai: amount hoặc increment', 400, 'VALIDATION_ERROR');
  }
  if (!Number.isInteger(hasAmount ? requested : increment) || (hasAmount ? requested : increment) <= 0) {
    throw new AppError('Giá đặt phải là số nguyên dương (VND)', 400, 'VALIDATION_ERROR');
  }

  const result = await inTransaction(async (client) => {
    const a = await auctionModel.lockById(client, auctionId);
    if (!a) throw new AppError('Không tìm thấy phiên đấu giá', 404, 'NOT_FOUND');
    assertBiddable(a);
    const amount = hasIncrement ? Number(a.current_price) + increment : requested;

    const dep = await client.query(
      `SELECT status FROM auction_deposits WHERE auction_id = $1 AND bidder_id = $2`,
      [auctionId, bidderId],
    );
    if (!dep.rows[0] || dep.rows[0].status !== 'held') {
      throw new AppError('Cần đặt cọc tham gia trước khi đặt giá', 403, 'DEPOSIT_REQUIRED');
    }

    const latest = await bidModel.findLatest(client, auctionId);
    if (latest && String(latest.bidder_id) === String(bidderId)) {
      throw new AppError('Bạn đang dẫn đầu phiên này', 409, 'ALREADY_LEADING');
    }

    const minBid = Number(a.current_price) + Number(a.bid_step);
    if (amount < minBid) {
      throw new AppError(`Giá tối thiểu là ${fmt(minBid)}`, 400, 'BID_TOO_LOW');
    }

    const now = new Date();
    const bid = await bidModel.insert(client, { auctionId, bidderId, amount });

    // Anti-sniping: đặt giá trong 30 giây cuối thì phiên còn đúng 30 giây.
    let endsAt = new Date(a.ends_at);
    let extended = false;
    if (endsAt.getTime() - now.getTime() <= SNIPE_WINDOW_MS) {
      endsAt = new Date(now.getTime() + SNIPE_WINDOW_MS);
      extended = true;
    }
    await client.query(
      `UPDATE auctions SET current_price = $2, bid_count = bid_count + 1, ends_at = $3 WHERE id = $1`,
      [auctionId, amount, endsAt],
    );

    let outbid = null;
    if (latest) {
      outbid = await createNotification(client, {
        accountId: latest.bidder_id,
        type: 'outbid',
        title: `Bạn đã bị vượt giá · ${a.title} · ${fmt(amount)}`,
      });
    }

    const who = await client.query('SELECT full_name FROM accounts WHERE id = $1', [bidderId]);
    return {
      bidId: bid.id,
      at: bid.created_at,
      currentPrice: amount,
      bidCount: a.bid_count + 1,
      endsAt,
      extended,
      outbid,
      who: auctionModel.maskName(who.rows[0]?.full_name),
    };
  });

  // Sau COMMIT mới đẩy real-time, để client không nhận dữ liệu chưa chốt.
  emit(`auction:${auctionId}`, 'auction:update', {
    auctionId: String(auctionId),
    reason: 'bid', // 'paused' | 'resumed' do sockets/pause_listener.js gửi
    currentPrice: result.currentPrice,
    bidCount: result.bidCount,
    endsAt: result.endsAt,
    bid: { who: result.who, amount: result.currentPrice, at: result.at },
  });
  emitNotification(result.outbid);

  // Phát hiện gian lận chạy nền, không chặn phản hồi đặt giá.
  setImmediate(() => {
    require('./fraud_detection').scanAuction(auctionId).catch((err) => console.error('[fraud]', err.message));
  });

  return {
    bidId: result.bidId,
    currentPrice: result.currentPrice,
    bidCount: result.bidCount,
    endsAt: result.endsAt,
    extended: result.extended,
  };
}

// ---------- Đóng phiên ----------

// Đóng một phiên đã hết giờ. Trả về null nếu phiên đang bị xử lý chỗ khác / chưa hết giờ.
async function closeAuction(auctionId) {
  const outcome = await inTransaction(async (client) => {
    const a = await auctionModel.lockById(client, auctionId, { skipLocked: true });
    if (!a || a.status !== 'active' || new Date(a.ends_at) > new Date() || a.paused) return null;

    const notes = [];
    const latest = await bidModel.findLatest(client, auctionId);

    if (!latest) {
      await client.query(`UPDATE auctions SET status = 'ended' WHERE id = $1`, [auctionId]);
      await client.query(`UPDATE listings SET status = 'ended' WHERE id = $1`, [a.listing_id]);
      return { auctionId, hasWinner: false, notes };
    }

    const winnerId = latest.bidder_id;
    const finalPrice = Number(a.current_price);
    await client.query(
      `UPDATE auctions SET status = 'ended', winner_id = $2 WHERE id = $1`,
      [auctionId, winnerId],
    );
    await client.query(`UPDATE listings SET status = 'ended' WHERE id = $1`, [a.listing_id]);

    const order = await client.query(
      `INSERT INTO orders (auction_id, bidder_id, seller_id, final_price, payment_deadline)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)
       RETURNING id`,
      [auctionId, winnerId, a.seller_id, finalPrice, String(PAYMENT_WINDOW_MS)],
    );

    const deposits = await client.query(
      `SELECT id, bidder_id, amount FROM auction_deposits
       WHERE auction_id = $1 AND status = 'held' ORDER BY id`,
      [auctionId],
    );
    for (const d of deposits.rows) {
      const amount = Number(d.amount);
      if (String(d.bidder_id) === String(winnerId)) {
        await client.query(`UPDATE auction_deposits SET status = 'applied_to_payment' WHERE id = $1`, [d.id]);
        notes.push(await createNotification(client, {
          accountId: d.bidder_id,
          type: 'win',
          title: `Bạn đã thắng phiên · ${a.title} · giá chốt ${fmt(finalPrice)}. Thanh toán trong 24 giờ.`,
        }));
      } else {
        await client.query(`UPDATE auction_deposits SET status = 'released' WHERE id = $1`, [d.id]);
        await walletService.releaseDeposit(client, { bidderId: d.bidder_id, auctionId, amount });
        notes.push(await createNotification(client, {
          accountId: d.bidder_id,
          type: 'refund',
          title: `Đã hoàn cọc ${fmt(amount)} · ${a.title} (bạn không thắng phiên)`,
        }));
      }
    }
    notes.push(await createNotification(client, {
      accountId: a.seller_id,
      type: 'sold',
      title: `Phiên "${a.title}" đã kết thúc với giá ${fmt(finalPrice)}`,
    }));
    return { auctionId, hasWinner: true, orderId: order.rows[0].id, notes };
  });

  if (!outcome) return null;
  emit(`auction:${auctionId}`, 'auction:ended', { auctionId: String(auctionId), hasWinner: outcome.hasWinner });
  outcome.notes.forEach(emitNotification);
  return { auctionId: outcome.auctionId, hasWinner: outcome.hasWinner, orderId: outcome.orderId || null };
}

async function closeExpiredAuctions() {
  const ids = await auctionModel.findExpiredIds(pool);
  const closed = [];
  for (const id of ids) {
    try {
      const r = await closeAuction(id);
      if (r) closed.push(r);
    } catch (err) {
      console.error(`[auction] lỗi đóng phiên ${id}:`, err.message);
    }
  }
  return closed;
}

// Admin huỷ / chấm dứt phiên (BE2 gọi): huỷ phiên và hoàn cọc toàn bộ người tham gia.
// `client` nằm trong giao dịch của nơi gọi.
async function cancelAuction(client, auctionId, { reason = 'Phiên bị huỷ bởi quản trị' } = {}) {
  const a = await auctionModel.lockById(client, auctionId);
  if (!a) throw new AppError('Không tìm thấy phiên đấu giá', 404, 'NOT_FOUND');
  if (a.status !== 'active') throw new AppError('Chỉ huỷ được phiên đang diễn ra', 409, 'AUCTION_ENDED');

  await client.query(`UPDATE auctions SET status = 'cancelled' WHERE id = $1`, [auctionId]);
  await client.query(`UPDATE listings SET status = 'cancelled' WHERE id = $1`, [a.listing_id]);
  const notes = [];
  const deposits = await client.query(
    `SELECT id, bidder_id, amount FROM auction_deposits WHERE auction_id = $1 AND status = 'held'`,
    [auctionId],
  );
  for (const d of deposits.rows) {
    await client.query(`UPDATE auction_deposits SET status = 'released' WHERE id = $1`, [d.id]);
    await walletService.releaseDeposit(client, {
      bidderId: d.bidder_id, auctionId, amount: Number(d.amount),
    });
    notes.push(await createNotification(client, {
      accountId: d.bidder_id,
      type: 'refund',
      title: `Phiên "${a.title}" đã bị huỷ (${reason}). Cọc ${fmt(d.amount)} đã hoàn về ví.`,
    }));
  }
  return { notes, emit: () => {
    emit(`auction:${auctionId}`, 'auction:ended', { auctionId: String(auctionId), hasWinner: false, cancelled: true });
    notes.forEach(emitNotification);
  } };
}

// ---------- Đơn hàng: xem, thanh toán, quá hạn ----------

function orderView(r) {
  const finalPrice = Number(r.final_price);
  const fee = feeFor(finalPrice);
  const deposit = Number(r.deposit_amount || 0);
  const totalDue = finalPrice + fee + SHIPPING_FEE;
  return {
    id: r.id,
    auctionId: r.auction_id,
    title: r.title,
    finalPrice,
    fee,
    shippingFee: SHIPPING_FEE,
    totalDue,
    depositApplied: deposit,
    amountToPay: Math.max(totalDue - deposit, 0),
    paymentStatus: r.payment_status,
    paymentDeadline: r.payment_deadline,
    payoutStatus: r.payout_status,
    createdAt: r.created_at,
  };
}

const ORDER_SELECT = `
  SELECT o.id, o.auction_id, o.bidder_id, o.final_price, o.payment_status, o.payment_deadline,
         o.payout_status, o.created_at, l.title,
         (SELECT d.amount FROM auction_deposits d
          WHERE d.auction_id = o.auction_id AND d.bidder_id = o.bidder_id) AS deposit_amount
  FROM orders o
  JOIN auctions a ON a.id = o.auction_id
  JOIN listings l ON l.id = a.listing_id
`;

async function listOrdersForBidder(bidderId) {
  const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.bidder_id = $1 ORDER BY o.id DESC`, [bidderId]);
  return rows.map(orderView);
}

async function getOrderForBidder(bidderId, orderId) {
  const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.id = $1`, [orderId]);
  if (!rows[0] || String(rows[0].bidder_id) !== String(bidderId)) {
    throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
  }
  return orderView(rows[0]);
}

// Thanh toán đơn thắng. method: 'wallet' (trừ ví) | 'qr' | 'card' (cổng ngoài, giả lập thành công).
async function payOrder({ bidderId, orderId, method = 'wallet' }) {
  if (!['wallet', 'qr', 'card'].includes(method)) {
    throw new AppError('Phương thức thanh toán không hợp lệ', 400, 'VALIDATION_ERROR');
  }
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT o.id, o.auction_id, o.bidder_id, o.final_price, o.payment_status, o.payment_deadline
       FROM orders o WHERE o.id = $1 FOR UPDATE`,
      [orderId],
    );
    const o = rows[0];
    if (!o || String(o.bidder_id) !== String(bidderId)) {
      throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
    }
    if (o.payment_status === 'paid') throw new AppError('Đơn hàng đã được thanh toán', 409, 'ALREADY_PAID');
    if (o.payment_status === 'expired' || new Date(o.payment_deadline) < new Date()) {
      throw new AppError('Đơn hàng đã quá hạn thanh toán', 409, 'PAYMENT_EXPIRED');
    }

    const dep = await client.query(
      `SELECT id, amount FROM auction_deposits
       WHERE auction_id = $1 AND bidder_id = $2 AND status = 'applied_to_payment'`,
      [o.auction_id, bidderId],
    );
    const depositAmount = dep.rows[0] ? Number(dep.rows[0].amount) : 0;
    const finalPrice = Number(o.final_price);
    const totalDue = finalPrice + feeFor(finalPrice) + SHIPPING_FEE;

    const tx = await walletService.payOrder(client, {
      bidderId,
      auctionId: o.auction_id,
      totalDue,
      depositAmount,
      viaWallet: method === 'wallet',
    });
    await client.query(`UPDATE orders SET payment_status = 'paid' WHERE id = $1`, [orderId]);
    return { orderId: o.id, paymentStatus: 'paid', totalDue, balanceAfter: tx.balanceAfter };
  });
}

// Quá 24 giờ chưa thanh toán: mất cọc, huỷ giao dịch.
async function processPaymentTimeouts() {
  const { rows } = await pool.query(
    `SELECT id FROM orders WHERE payment_status = 'awaiting_payment' AND payment_deadline < now() ORDER BY id`,
  );
  const expired = [];
  for (const { id } of rows) {
    try {
      const note = await inTransaction(async (client) => {
        const r = await client.query(
          `SELECT o.id, o.auction_id, o.bidder_id, l.title, a.listing_id
           FROM orders o JOIN auctions a ON a.id = o.auction_id JOIN listings l ON l.id = a.listing_id
           WHERE o.id = $1 AND o.payment_status = 'awaiting_payment' AND o.payment_deadline < now()
           FOR UPDATE OF o SKIP LOCKED`,
          [id],
        );
        const o = r.rows[0];
        if (!o) return undefined;

        await client.query(`UPDATE orders SET payment_status = 'expired' WHERE id = $1`, [id]);
        await client.query(`UPDATE listings SET status = 'cancelled' WHERE id = $1`, [o.listing_id]);
        const dep = await client.query(
          `UPDATE auction_deposits SET status = 'forfeited'
           WHERE auction_id = $1 AND bidder_id = $2 AND status = 'applied_to_payment'
           RETURNING amount`,
          [o.auction_id, o.bidder_id],
        );
        if (dep.rows[0]) {
          await walletService.forfeitDeposit(client, {
            bidderId: o.bidder_id, auctionId: o.auction_id, amount: Number(dep.rows[0].amount),
          });
        }
        return createNotification(client, {
          accountId: o.bidder_id,
          type: 'warn',
          title: `Quá hạn thanh toán · ${o.title}. Cọc đã bị tịch thu và giao dịch bị huỷ.`,
        });
      });
      if (note !== undefined) { emitNotification(note); expired.push(id); }
    } catch (err) {
      console.error(`[auction] lỗi xử lý quá hạn đơn ${id}:`, err.message);
    }
  }
  return expired;
}

module.exports = {
  DEFAULT_BID_STEP,
  depositFor,
  inTransaction,
  createAuctionForListing,
  listAuctions,
  getAuction,
  joinAuction,
  placeBid,
  closeAuction,
  closeExpiredAuctions,
  cancelAuction,
  listOrdersForBidder,
  getOrderForBidder,
  payOrder,
  processPaymentTimeouts,
};
