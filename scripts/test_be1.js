// Kiểm thử end-to-end phần BE1 trên DB dùng chung bằng dữ liệu tạm có tiền tố riêng:
//   tài khoản  email  test_be1_<tên>_<số>@be1test.local, họ tên  test_be1_<tên>
//   tin đăng   tiêu đề test_be1_item
// Mọi thao tác ghi/xoá chỉ chạm các dòng đi ra từ những tài khoản đó; dữ liệu thật và dữ
// liệu của người khác không bị sửa hay xoá. Dọn sạch khi xong (kể cả khi test lỗi).
// Chạy: npm run test:be1   (hoặc node scripts/test_be1.js)
const assert = require('assert');
const { pool } = require('../src/config/db');
const engine = require('../src/services/auction_engine');
const walletService = require('../src/services/wallet_service');
const fraud = require('../src/services/fraud_detection');

const PREFIX = 'test_be1_';
const DOMAIN = '@be1test.local';
// LIKE: dấu _ là ký tự đại diện nên phải escape để chỉ khớp đúng tiền tố.
const EMAIL_LIKE = `test\\_be1\\_%${DOMAIN}`;
let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const rejects = async (promise, code) => {
  try { await promise; } catch (e) { assert.strictEqual(e.code, code, `mong ${code}, nhận ${e.code}: ${e.message}`); return; }
  assert.fail(`mong lỗi ${code} nhưng không có lỗi`);
};

async function mkAccount(role, name) {
  const email = `${PREFIX}${name.toLowerCase()}_${Date.now()}_${Math.floor(Math.random() * 1e6)}${DOMAIN}`;
  const { rows } = await pool.query(
    `INSERT INTO accounts (full_name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [PREFIX + name, email]);
  const id = rows[0].id;
  if (role === 'bidder') await pool.query('INSERT INTO bidders (account_id) VALUES ($1)', [id]);
  else await pool.query(`INSERT INTO sellers (account_id, store_name) VALUES ($1, 'Test shop')`, [id]);
  return id;
}

async function mkAuction(sellerId, startPrice = 1_000_000) {
  const cat = (await pool.query(`SELECT id FROM categories WHERE code = 'shoes'`)).rows[0].id;
  const l = await pool.query(
    `INSERT INTO listings (seller_id, category_id, title, starting_price, duration_hours, status)
     VALUES ($1, $2, $4, $3, 1, 'approved') RETURNING id`, [sellerId, cat, startPrice, `${PREFIX}item`]);
  const auctionId = await engine.inTransaction((c) => engine.createAuctionForListing(c, l.rows[0].id));
  return { listingId: l.rows[0].id, auctionId };
}

const wallet = async (id) => (await pool.query(
  'SELECT wallet_balance::int AS b, wallet_held::int AS h FROM bidders WHERE account_id = $1', [id])).rows[0];
const expire = (auctionId) => pool.query(`UPDATE auctions SET ends_at = now() - interval '1 second', starts_at = now() - interval '1 hour' WHERE id = $1`, [auctionId]);

// Chỉ xoá những dòng đi ra từ tài khoản test_be1_*: phiên của người bán test, và mọi dòng
// của người mua test. Không có điều kiện nào có thể khớp dữ liệu thật.
async function cleanup() {
  const ids = (await pool.query(`SELECT id FROM accounts WHERE email LIKE $1`, [EMAIL_LIKE])).rows.map((r) => r.id);
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]);
  const aucs = `SELECT a.id FROM auctions a JOIN listings l ON l.id = a.listing_id WHERE l.seller_id = ANY($1)`;
  await q(`DELETE FROM flag_evidence WHERE flagged_auction_id IN (SELECT id FROM flagged_auctions WHERE auction_id IN (${aucs}))`);
  await q(`DELETE FROM flagged_auctions WHERE auction_id IN (${aucs})`);
  await q(`DELETE FROM wallet_transactions WHERE bidder_id = ANY($1)`);
  await q(`DELETE FROM orders WHERE seller_id = ANY($1) OR bidder_id = ANY($1)`);
  await q(`DELETE FROM bids WHERE auction_id IN (${aucs}) OR bidder_id = ANY($1)`);
  await q(`DELETE FROM auction_deposits WHERE auction_id IN (${aucs}) OR bidder_id = ANY($1)`);
  await q(`DELETE FROM auctions WHERE id IN (${aucs})`);
  await q(`DELETE FROM listings WHERE seller_id = ANY($1)`);
  await q(`DELETE FROM accounts WHERE id = ANY($1)`); // cascade: bidders, sellers, notifications
}

// Một server khác (của đồng đội) cùng trỏ vào DB này có thể đóng phiên test của mình trước
// khi test gọi. Kết quả cuối cùng là như nhau, nên chờ tối đa vài giây tới khi DB ở đúng trạng thái.
async function closedAuction(auctionId) {
  const r = await engine.closeAuction(auctionId);
  for (let i = 0; i < 20; i += 1) {
    const a = (await pool.query('SELECT status FROM auctions WHERE id = $1', [auctionId])).rows[0];
    if (a.status !== 'active') return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  return r;
}

async function main() {
  await cleanup(); // dọn rác của lần chạy trước nếu bị ngắt giữa chừng
  const seller = await mkAccount('seller', 'Seller');
  const [A, B, C] = [await mkAccount('bidder', 'Alice'), await mkAccount('bidder', 'Bob'), await mkAccount('bidder', 'Carl')];
  const tx = (f) => engine.inTransaction(f);

  console.log('Ví');
  await step('nạp tiền, từ chối số tiền sai', async () => {
    await tx((c) => walletService.topUp(c, { bidderId: A, amount: 5_000_000 }));
    await tx((c) => walletService.topUp(c, { bidderId: B, amount: 5_000_000 }));
    await tx((c) => walletService.topUp(c, { bidderId: C, amount: 50_000 }));
    await rejects(tx((c) => walletService.topUp(c, { bidderId: A, amount: -5 })), 'VALIDATION_ERROR');
    assert.deepStrictEqual(await wallet(A), { b: 5_000_000, h: 0 });
  });

  console.log('Tham gia & đặt giá');
  const { auctionId } = await mkAuction(seller, 1_000_000); // cọc 10% = 100.000
  await step('cọc = 10% giá khởi điểm, giữ trong ví', async () => {
    const r = await engine.joinAuction({ bidderId: A, auctionId });
    assert.strictEqual(r.deposit, 100_000);
    assert.deepStrictEqual(await wallet(A), { b: 4_900_000, h: 100_000 });
    await engine.joinAuction({ bidderId: B, auctionId });
  });
  await step('không cọc hai lần / không đủ tiền cọc', async () => {
    await rejects(engine.joinAuction({ bidderId: A, auctionId }), 'ALREADY_JOINED');
    await rejects(engine.joinAuction({ bidderId: C, auctionId }), 'INSUFFICIENT_FUNDS');
    assert.deepStrictEqual(await wallet(C), { b: 50_000, h: 0 }); // rollback sạch
  });
  await step('chưa cọc thì không được đặt giá', async () => {
    await rejects(engine.placeBid({ bidderId: C, auctionId, amount: 1_100_000 }), 'DEPOSIT_REQUIRED');
  });
  await step('giá phải >= giá hiện tại + bước giá', async () => {
    await rejects(engine.placeBid({ bidderId: A, auctionId, amount: 1_000_000 }), 'BID_TOO_LOW');
    await rejects(engine.placeBid({ bidderId: A, auctionId, amount: 1_049_999 }), 'BID_TOO_LOW');
    await engine.placeBid({ bidderId: A, auctionId, amount: 1_050_000 });
  });
  await step('không tự vượt giá chính mình', async () => {
    await rejects(engine.placeBid({ bidderId: A, auctionId, amount: 1_200_000 }), 'ALREADY_LEADING');
  });
  await step('bị vượt giá thì có thông báo outbid', async () => {
    await engine.placeBid({ bidderId: B, auctionId, amount: 1_100_000 });
    const n = await pool.query(`SELECT type FROM notifications WHERE account_id = $1 AND type = 'outbid'`, [A]);
    assert.strictEqual(n.rowCount, 1);
  });
  await step('hai người đặt cùng lúc: chỉ một người thắng lượt', async () => {
    const results = await Promise.allSettled([
      engine.placeBid({ bidderId: A, auctionId, amount: 1_150_000 }),
      engine.placeBid({ bidderId: B, auctionId, amount: 1_150_000 }),
    ]);
    // B đang dẫn đầu nên B bị ALREADY_LEADING; A thắng. Dù thứ tự nào, giá chỉ tăng đúng 1 bước.
    const a = await pool.query('SELECT current_price::int AS p, bid_count FROM auctions WHERE id = $1', [auctionId]);
    assert.strictEqual(a.rows[0].p, 1_150_000);
    assert.strictEqual(a.rows[0].bid_count, 3);
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  });
  await step('chống chốt phút chót: đặt giá trong 30 giây cuối gia hạn đúng 30 giây', async () => {
    await pool.query(`UPDATE auctions SET ends_at = now() + interval '10 seconds' WHERE id = $1`, [auctionId]);
    const r = await engine.placeBid({ bidderId: B, auctionId, amount: 1_200_000 });
    assert.strictEqual(r.extended, true);
    const left = new Date(r.endsAt) - Date.now();
    assert.ok(left > 25_000 && left <= 30_500, `còn ${left}ms`);
  });

  console.log('Đóng phiên');
  await step('hết giờ: chọn người thắng, tạo đơn, hoàn cọc người thua', async () => {
    assert.strictEqual(await engine.closeAuction(auctionId), null); // chưa hết giờ -> bỏ qua
    await expire(auctionId);
    await closedAuction(auctionId);
    const a =(await pool.query('SELECT status, winner_id FROM auctions WHERE id = $1', [auctionId])).rows[0];
    assert.strictEqual(a.status, 'ended');
    assert.strictEqual(String(a.winner_id), String(B));
    assert.deepStrictEqual(await wallet(A), { b: 5_000_000, h: 0 });        // A thua: nhận lại cọc
    assert.deepStrictEqual(await wallet(B), { b: 4_900_000, h: 100_000 });  // B thắng: cọc chờ trừ vào thanh toán
    assert.strictEqual(await engine.closeAuction(auctionId), null);         // đóng lại không tạo đơn thứ hai
    const o = (await pool.query('SELECT * FROM orders WHERE auction_id = $1', [auctionId])).rows[0];
    assert.strictEqual(o.payment_status, 'awaiting_payment');
    assert.ok(Math.abs(new Date(o.payment_deadline) - Date.now() - 24 * 3600_000) < 60_000);
  });
  await step('đã kết thúc thì không đặt giá / tham gia nữa', async () => {
    await rejects(engine.placeBid({ bidderId: A, auctionId, amount: 9_000_000 }), 'AUCTION_ENDED');
    await rejects(engine.joinAuction({ bidderId: C, auctionId }), 'AUCTION_ENDED');
  });

  console.log('Thanh toán');
  const order = (await engine.listOrdersForBidder(B))[0];
  await step('đơn hiển thị giá + phí 5% + vận chuyển, trừ cọc', async () => {
    assert.strictEqual(order.finalPrice, 1_200_000);
    assert.strictEqual(order.fee, 60_000);
    assert.strictEqual(order.totalDue, 1_300_000);
    assert.strictEqual(order.amountToPay, 1_200_000);
  });
  await step('người khác không thanh toán được đơn của B', async () => {
    await rejects(engine.payOrder({ bidderId: A, orderId: order.id }), 'NOT_FOUND');
  });
  await step('thanh toán bằng ví: trừ phần còn lại, giải phóng cọc', async () => {
    await engine.payOrder({ bidderId: B, orderId: order.id, method: 'wallet' });
    assert.deepStrictEqual(await wallet(B), { b: 3_700_000, h: 0 });
    await rejects(engine.payOrder({ bidderId: B, orderId: order.id }), 'ALREADY_PAID');
  });

  console.log('Quá hạn thanh toán');
  await step('quá 24 giờ: mất cọc, đơn expired', async () => {
    const { auctionId: a2 } = await mkAuction(seller, 2_000_000); // cọc 200.000
    await engine.joinAuction({ bidderId: A, auctionId: a2 });
    await engine.placeBid({ bidderId: A, auctionId: a2, amount: 2_050_000 });
    await expire(a2);
    await closedAuction(a2);
    await pool.query(`UPDATE orders SET payment_deadline = now() - interval '1 minute' WHERE auction_id = $1`, [a2]);
    await engine.processPaymentTimeouts();
    for (let i = 0; i < 20; i += 1) { // có thể server khác đã xử lý trước: chờ DB đúng trạng thái
      const o = (await pool.query('SELECT payment_status FROM orders WHERE auction_id = $1', [a2])).rows[0];
      if (o.payment_status === 'expired') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.deepStrictEqual(await wallet(A), { b: 4_800_000, h: 0 });
    const d = await pool.query(`SELECT status FROM auction_deposits WHERE auction_id = $1`, [a2]);
    assert.strictEqual(d.rows[0].status, 'forfeited');
    const t = await pool.query(`SELECT 1 FROM wallet_transactions WHERE bidder_id = $1 AND kind = 'deposit_forfeit'`, [A]);
    assert.strictEqual(t.rowCount, 1);
  });

  console.log('Phiên không ai đặt giá & huỷ phiên');
  await step('không có lượt đặt giá: đóng phiên, không tạo đơn', async () => {
    const { auctionId: a3 } = await mkAuction(seller);
    await expire(a3);
    await closedAuction(a3);
    assert.strictEqual((await pool.query('SELECT status FROM auctions WHERE id = $1', [a3])).rows[0].status, 'ended');
    assert.strictEqual((await pool.query('SELECT 1 FROM orders WHERE auction_id = $1', [a3])).rowCount, 0);
  });
  await step('Admin huỷ phiên: hoàn cọc mọi người tham gia', async () => {
    const { auctionId: a4 } = await mkAuction(seller);
    const before = await wallet(B);
    await engine.joinAuction({ bidderId: B, auctionId: a4 });
    const done = await tx((c) => engine.cancelAuction(c, a4));
    done.emit();
    assert.deepStrictEqual(await wallet(B), before);
  });
  await step('phiên bị tạm dừng thì không đặt giá được', async () => {
    const { auctionId: a5 } = await mkAuction(seller);
    await engine.joinAuction({ bidderId: B, auctionId: a5 });
    await pool.query(
      `INSERT INTO flagged_auctions (auction_id, severity, confidence, status) VALUES ($1, 'high', 90, 'paused')`, [a5]);
    await rejects(engine.placeBid({ bidderId: B, auctionId: a5, amount: 1_050_000 }), 'AUCTION_PAUSED');
  });

  console.log('Tạm dừng đóng băng đồng hồ');
  // Admin (BE2) tạm dừng bằng cách đổi flagged_auctions.status; trigger ở migration 006 lo phần đồng hồ.
  const flag = (auctionId, status) => pool.query(
    `INSERT INTO flagged_auctions (auction_id, severity, confidence, reason, status)
     VALUES ($1, 'high', 90, $2, $3) RETURNING id`, [auctionId, `${PREFIX}pause_${Math.random()}`, status]).then((r) => r.rows[0].id);
  const clock = async (auctionId) => (await pool.query(
    `SELECT ends_at, paused_at, status FROM auctions WHERE id = $1`, [auctionId])).rows[0];
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  await step('tạm dừng rồi tiếp tục: ends_at dịch đúng bằng thời gian đã dừng', async () => {
    const { auctionId: ap } = await mkAuction(seller);
    await engine.joinAuction({ bidderId: A, auctionId: ap });
    await engine.placeBid({ bidderId: A, auctionId: ap, amount: 1_050_000 });
    await pool.query(`UPDATE auctions SET ends_at = now() + interval '3 seconds', starts_at = now() - interval '1 hour' WHERE id = $1`, [ap]);
    const before = await clock(ap);

    const t0 = Date.now();
    const f = await flag(ap, 'paused');
    const paused = await clock(ap);
    assert.ok(paused.paused_at, 'paused_at phải được ghi khi tạm dừng');
    assert.strictEqual(new Date(paused.ends_at).getTime(), new Date(before.ends_at).getTime()); // chưa dịch

    await sleep(4500); // dừng lâu hơn thời gian còn lại (3 giây)
    const view = await engine.getAuction(ap, A);
    assert.strictEqual(view.paused, true);
    assert.ok(view.remainingSeconds >= 2 && view.remainingSeconds <= 3, `còn ${view.remainingSeconds}s, mong ~3s (đứng yên)`);
    await engine.closeExpiredAuctions();
    assert.strictEqual((await clock(ap)).status, 'active', 'job đóng phiên không được đóng phiên đang tạm dừng');

    await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f]);
    const elapsed = Date.now() - t0;
    const after = await clock(ap);
    assert.strictEqual(after.paused_at, null);
    const shift = new Date(after.ends_at) - new Date(before.ends_at);
    assert.ok(Math.abs(shift - elapsed) < 1500, `ends_at dịch ${shift}ms, thời gian dừng ~${elapsed}ms`);
    assert.ok(new Date(after.ends_at) > new Date(), 'tiếp tục xong thì phiên vẫn còn giờ, không đóng ngay');
    await engine.closeExpiredAuctions();
    assert.strictEqual((await clock(ap)).status, 'active');
    const resumed = await engine.getAuction(ap, A);
    assert.strictEqual(resumed.paused, false);
    assert.ok(resumed.remainingSeconds >= 1 && resumed.remainingSeconds <= 3, `còn ${resumed.remainingSeconds}s`);
  });
  await step('hai cờ tạm dừng: gỡ một cờ thì vẫn dừng, gỡ cờ cuối mới chạy lại', async () => {
    const { auctionId: ap2 } = await mkAuction(seller);
    const f1 = await flag(ap2, 'paused');
    const f2 = await flag(ap2, 'paused');
    const p1 = (await clock(ap2)).paused_at;
    await sleep(600);
    await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f1]);
    const mid = await clock(ap2);
    assert.ok(mid.paused_at, 'còn một cờ paused nên vẫn tạm dừng');
    assert.strictEqual(new Date(mid.paused_at).getTime(), new Date(p1).getTime());
    await pool.query(`UPDATE flagged_auctions SET status = 'verify' WHERE id = $1`, [f2]);
    assert.strictEqual((await clock(ap2)).paused_at, null);
  });
  await step('Admin chấm dứt phiên đang tạm dừng: phiên huỷ, không còn tính thời gian dừng', async () => {
    const { auctionId: ap3 } = await mkAuction(seller);
    await engine.joinAuction({ bidderId: B, auctionId: ap3 });
    const f = await flag(ap3, 'paused');
    await tx(async (c) => {
      const done = await engine.cancelAuction(c, ap3);
      await c.query(`UPDATE flagged_auctions SET status = 'terminated' WHERE id = $1`, [f]);
      return done;
    });
    const a = await clock(ap3);
    assert.strictEqual(a.status, 'cancelled');
    assert.strictEqual(a.paused_at, null);
  });

  console.log('Phát hiện gian lận');
  await step('luật ping-pong / dồn dập / nhảy giá', async () => {
    const t0 = Date.now();
    const mk = (who, amount, s) => ({ bidderId: who, amount, at: new Date(t0 + s * 1000), accountCreatedAt: new Date(0) });
    const pp = fraud.analyze([mk('1', 100, 0), mk('2', 150, 5), mk('1', 200, 10), mk('2', 250, 15), mk('1', 300, 20), mk('2', 350, 25)]);
    assert.ok(pp.some((s) => s.code === 'ping_pong'));
    const burst = fraud.analyze([1, 2, 3, 4, 5].map((i) => mk('1', 100 * i, i)));
    assert.ok(burst.some((s) => s.code === 'burst'));
    const jump = fraud.analyze([mk('1', 100, 0), mk('2', 400, 5)]);
    assert.ok(jump.some((s) => s.code === 'price_jump'));
    assert.strictEqual(fraud.analyze([mk('1', 100, 0), mk('2', 150, 5), mk('3', 200, 10)]).length, 0);
  });
  await step('scanAuction ghi flagged_auctions, không trùng lặp', async () => {
    const { auctionId: a6 } = await mkAuction(seller, 100_000);
    for (const id of [A, B]) {
      await tx((c) => walletService.topUp(c, { bidderId: id, amount: 2_000_000 }));
      await engine.joinAuction({ bidderId: id, auctionId: a6 });
    }
    let price = 100_000;
    for (let i = 0; i < 6; i += 1) {
      price += 50_000;
      await engine.placeBid({ bidderId: i % 2 ? B : A, auctionId: a6, amount: price });
    }
    await new Promise((r) => setTimeout(r, 1500)); // chờ quét nền sau mỗi lượt
    await fraud.scanAuction(a6);
    const f = await pool.query(`SELECT id, severity FROM flagged_auctions WHERE auction_id = $1 AND reason LIKE 'Chỉ hai%'`, [a6]);
    assert.strictEqual(f.rowCount, 1);
    assert.strictEqual(f.rows[0].severity, 'high');
    const ev = await pool.query('SELECT 1 FROM flag_evidence WHERE flagged_auction_id = $1', [f.rows[0].id]);
    assert.ok(ev.rowCount >= 1);
  });

  console.log(`\nTất cả ${passed} bước đạt.`);
}

main()
  .catch((err) => { console.error('\n✗ THẤT BẠI:', err); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch((e) => console.error('cleanup lỗi:', e.message)); await pool.end(); });
