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

async function cleanupOps() {
  await pool.query(`DELETE FROM ops_accounts WHERE email LIKE $1`, [EMAIL_LIKE]);
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
  await cleanupOps();
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

  console.log('Đồng thời (nhiều request song song)');
  await step('đặt giá kiểu increment song song: giá đọc sau khi khoá, hai người nhận hai mức liên tiếp', async () => {
    const { auctionId: ar } = await mkAuction(seller, 1_000_000); // bước giá 50.000
    await engine.joinAuction({ bidderId: A, auctionId: ar });
    await engine.joinAuction({ bidderId: B, auctionId: ar });
    const rs = await Promise.allSettled([
      engine.placeBid({ bidderId: A, auctionId: ar, increment: 50_000 }),
      engine.placeBid({ bidderId: B, auctionId: ar, increment: 50_000 }),
    ]);
    assert.deepStrictEqual(rs.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(rs.map((r) => r.reason?.code)));
    const amounts = (await pool.query('SELECT amount::int AS a FROM bids WHERE auction_id = $1 ORDER BY id', [ar])).rows.map((r) => r.a);
    assert.deepStrictEqual(amounts, [1_050_000, 1_100_000]); // không có hai lượt cùng giá
    const au = (await pool.query('SELECT current_price::int AS p, bid_count FROM auctions WHERE id = $1', [ar])).rows[0];
    assert.deepStrictEqual(au, { p: 1_100_000, bid_count: 2 });

    // Vòng hai: tuỳ ai được khoá trước mà 1 lượt (người dẫn đầu đi trước nên bị ALREADY_LEADING) hoặc
    // 2 lượt (người kia đi trước rồi bị vượt lại) thành công. Bất biến: mỗi lượt thành công tăng đúng
    // một bước, lượt bị từ chối chỉ có thể là ALREADY_LEADING, và không có hai lượt cùng giá.
    const rs2 = await Promise.allSettled([
      engine.placeBid({ bidderId: A, auctionId: ar, increment: 50_000 }),
      engine.placeBid({ bidderId: B, auctionId: ar, increment: 50_000 }),
    ]);
    const okCount = rs2.filter((r) => r.status === 'fulfilled').length;
    assert.ok(okCount >= 1, JSON.stringify(rs2.map((r) => r.reason?.code)));
    assert.ok(rs2.every((r) => r.status === 'fulfilled' || r.reason.code === 'ALREADY_LEADING'));
    assert.strictEqual((await pool.query('SELECT current_price::int AS p FROM auctions WHERE id = $1', [ar])).rows[0].p, 1_100_000 + okCount * 50_000);
    const all = (await pool.query('SELECT amount::int AS a FROM bids WHERE auction_id = $1 ORDER BY id', [ar])).rows.map((r) => r.a);
    assert.deepStrictEqual(all, all.map((_, i) => 1_050_000 + i * 50_000));
    await rejects(engine.placeBid({ bidderId: A, auctionId: ar, amount: 2_000_000, increment: 50_000 }), 'VALIDATION_ERROR');
  });
  await step('nhiều lần quét gian lận song song: chỉ một cờ pending cho mỗi luật', async () => {
    const { auctionId: af } = await mkAuction(seller, 1_000_000);
    // Dựng sẵn 6 lượt xen kẽ A/B bằng SQL (không qua placeBid để không kích hoạt quét nền).
    for (let i = 0; i < 6; i += 1) {
      await pool.query(
        `INSERT INTO bids (auction_id, bidder_id, amount, created_at)
         VALUES ($1, $2, $3, now() - ($4 || ' seconds')::interval)`,
        [af, i % 2 ? B : A, 1_000_000 + (i + 1) * 50_000, String((6 - i) * 20)]);
    }
    const created = await Promise.all(Array.from({ length: 8 }, () => fraud.scanAuction(af)));
    assert.strictEqual(created.reduce((x, y) => x + y, 0), 1, `số cờ mới: ${created}`);
    const n = await pool.query(`SELECT count(*)::int AS n FROM flagged_auctions WHERE auction_id = $1 AND status = 'pending'`, [af]);
    assert.strictEqual(n.rows[0].n, 1);
    const ev = await pool.query(
      `SELECT count(*)::int AS n FROM flag_evidence e JOIN flagged_auctions f ON f.id = e.flagged_auction_id WHERE f.auction_id = $1`, [af]);
    assert.strictEqual(ev.rows[0].n, 2); // đúng một bộ bằng chứng, không bị nhân đôi
  });
  await step('unique index chặn hai cờ pending giống nhau chèn cùng lúc', async () => {
    const { auctionId: au2 } = await mkAuction(seller);
    const reason = `${PREFIX}dup_reason`;
    const ins = () => pool.query(
      `INSERT INTO flagged_auctions (auction_id, severity, confidence, reason) VALUES ($1, 'low', 10, $2)`, [au2, reason]);
    const rs = await Promise.allSettled([ins(), ins(), ins()]);
    assert.strictEqual(rs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => r.reason.code === '23505'));
    // Cờ đã xử lý (không còn pending) thì được tạo cờ mới cùng lý do.
    await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE auction_id = $1`, [au2]);
    await ins();
  });

  console.log('Người dùng báo cáo phiên đáng ngờ');
  const flagsOf = async (auctionId) => (await pool.query(
    `SELECT f.id, f.severity, f.status, f.reason,
            (SELECT count(*)::int FROM flag_evidence e WHERE e.flagged_auction_id = f.id) AS evidence
     FROM flagged_auctions f WHERE f.auction_id = $1 ORDER BY f.id`, [auctionId])).rows;
  await step('báo cáo phiên chưa có cờ: tạo cờ pending mức thấp kèm bằng chứng', async () => {
    const { auctionId: ap } = await mkAuction(seller);
    const r = await fraud.reportAuction({ reporterId: A, auctionId: ap, reason: 'Giá bất thường', note: 'Hai tài khoản đẩy giá' });
    assert.deepStrictEqual(r, { reported: true, flagCreated: true });
    const f = await flagsOf(ap);
    assert.strictEqual(f.length, 1);
    assert.deepStrictEqual([f[0].severity, f[0].status, f[0].evidence], ['low', 'pending', 1]);
    const ev = (await pool.query('SELECT label, value FROM flag_evidence WHERE flagged_auction_id = $1', [f[0].id])).rows[0];
    assert.strictEqual(ev.label, `Báo cáo từ người dùng #${A}`);
    assert.strictEqual(ev.value, 'Giá bất thường — Hai tài khoản đẩy giá');

    // Người thứ hai báo cáo: thêm bằng chứng vào cờ pending đó, không tạo cờ mới.
    const r2 = await fraud.reportAuction({ reporterId: B, auctionId: ap, reason: 'Nghi gian lận' });
    assert.deepStrictEqual(r2, { reported: true, flagCreated: false });
    const f2 = await flagsOf(ap);
    assert.deepStrictEqual([f2.length, f2[0].evidence], [1, 2]);
    // Một người chỉ báo một lần mỗi phiên.
    await rejects(fraud.reportAuction({ reporterId: A, auctionId: ap, reason: 'Lại báo' }), 'ALREADY_REPORTED');
    assert.strictEqual((await flagsOf(ap))[0].evidence, 2);
    await rejects(fraud.reportAuction({ reporterId: A, auctionId: '999999999', reason: 'x' }), 'NOT_FOUND');
  });
  await step('phiên đã có cờ pending do AI: thêm bằng chứng vào cờ đó, không tạo cờ mới', async () => {
    const { auctionId: ap } = await mkAuction(seller);
    for (let i = 0; i < 6; i += 1) {
      await pool.query(
        `INSERT INTO bids (auction_id, bidder_id, amount, created_at)
         VALUES ($1, $2, $3, now() - ($4 || ' seconds')::interval)`,
        [ap, i % 2 ? B : A, 1_000_000 + (i + 1) * 50_000, String((6 - i) * 20)]);
    }
    assert.strictEqual(await fraud.scanAuction(ap), 1);
    const before = await flagsOf(ap);
    assert.strictEqual(before[0].severity, 'high');
    const r = await fraud.reportAuction({ reporterId: C, auctionId: ap, reason: 'Thấy hai người đặt qua lại' });
    assert.strictEqual(r.flagCreated, false);
    const after = await flagsOf(ap);
    assert.deepStrictEqual([after.length, after[0].id, after[0].evidence], [1, before[0].id, before[0].evidence + 1]);
  });
  await step('cùng một người báo cáo song song: chỉ một báo cáo được ghi', async () => {
    const { auctionId: ap } = await mkAuction(seller);
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => fraud.reportAuction({ reporterId: A, auctionId: ap, reason: 'Spam' })));
    assert.strictEqual(rs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'ALREADY_REPORTED'));
    const f = await flagsOf(ap);
    assert.deepStrictEqual([f.length, f[0].evidence], [1, 1]);
  });
  await step('nhiều người báo cáo song song: một cờ, đủ bằng chứng', async () => {
    const { auctionId: ap } = await mkAuction(seller);
    const rs = await Promise.all([A, B, C].map((id) => fraud.reportAuction({ reporterId: id, auctionId: ap, reason: 'Nghi ngờ' })));
    assert.strictEqual(rs.filter((r) => r.flagCreated).length, 1);
    const f = await flagsOf(ap);
    assert.deepStrictEqual([f.length, f[0].evidence], [1, 3]);
  });
  await step('POST /api/auctions/:id/report: quyền, kiểm tra đầu vào, báo trùng', async () => {
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const { server } = require('../src/app');
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    try {
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const tok = (id, role) => jwt.sign({ sub: String(id), kind: 'account', role }, env.jwtSecret, { expiresIn: '5m' });
      const post = async (path, token, body) => {
        const r = await fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        });
        return { status: r.status, ...(await r.json()) };
      };
      const { auctionId: ap } = await mkAuction(seller);
      const path = `/auctions/${ap}/report`;
      assert.strictEqual((await post(path, null, { reason: 'x' })).status, 401);
      assert.strictEqual((await post(path, tok(seller, 'seller'), { reason: 'x' })).status, 403);
      assert.strictEqual((await post(path, tok(A, 'bidder'), {})).error.code, 'VALIDATION_ERROR');
      assert.strictEqual((await post(path, tok(A, 'bidder'), { reason: 'x'.repeat(101) })).error.code, 'VALIDATION_ERROR');
      assert.strictEqual((await post('/auctions/abc/report', tok(A, 'bidder'), { reason: 'x' })).error.code, 'VALIDATION_ERROR');
      assert.strictEqual((await post('/auctions/999999999/report', tok(A, 'bidder'), { reason: 'x' })).error.code, 'NOT_FOUND');
      const ok = await post(path, tok(A, 'bidder'), { reason: 'Giá lạ', note: 'ghi chú' });
      assert.deepStrictEqual([ok.status, ok.success, ok.data], [201, true, { reported: true, flagCreated: true }]);
      const dup = await post(path, tok(A, 'bidder'), { reason: 'Giá lạ' });
      assert.deepStrictEqual([dup.status, dup.error.code], [409, 'ALREADY_REPORTED']);

      // Gửi cả amount và increment, hoặc không gửi gì, đều bị từ chối trước khi đụng DB.
      const bad = await post('/bids', tok(A, 'bidder'), { auctionId: String(ap), amount: 1, increment: 1 });
      assert.deepStrictEqual([bad.status, bad.error.code], [400, 'VALIDATION_ERROR']);
    } finally {
      await new Promise((res) => server.close(res));
    }
  });

  console.log('Socket.io: tạm dừng / tiếp tục và ngắt tài khoản bị khoá');
  {
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const { io: ioClient } = require('socket.io-client');
    const { server } = require('../src/app');
    const registerSockets = require('../src/sockets');
    const pauseListener = require('../src/sockets/pause_listener');
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    await pauseListener.start();
    const url = `http://127.0.0.1:${server.address().port}`;
    const tok = (id, kind, role) => jwt.sign({ sub: String(id), kind, role }, env.jwtSecret, { expiresIn: '5m' });
    const sockets = [];
    // Kết nối; resolve socket khi vào được, reject với mã lỗi của server (UNAUTHORIZED, ACCOUNT_SUSPENDED...).
    const connect = (token) => new Promise((resolve, reject) => {
      const s = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(s);
      s.once('connect', () => resolve(s));
      s.once('connect_error', (e) => { s.close(); reject(e); });
    });
    // Chờ một sự kiện thoả điều kiện, hết hạn thì trả null.
    const waitFor = (s, event, pred = () => true, ms = 6000) => new Promise((resolve) => {
      const timer = setTimeout(() => { s.off(event, h); resolve(null); }, ms);
      function h(data) { if (pred(data)) { clearTimeout(timer); s.off(event, h); resolve(data ?? true); } }
      s.on(event, h);
    });
    const joinRoom = async (s, auctionId) => { s.emit('auction:join', String(auctionId)); await sleep(300); };
    const isFor = (id, reason) => (u) => u.auctionId === String(id) && u.reason === reason;

    try {
      await step('tạm dừng: phòng phiên nhận auction:update reason paused, đồng hồ đứng', async () => {
        const { auctionId: as } = await mkAuction(seller);
        const sA = await connect(tok(A, 'account', 'bidder'));
        await joinRoom(sA, as);
        const before = await clock(as);
        const got = waitFor(sA, 'auction:update', isFor(as, 'paused'));
        const f = await flag(as, 'paused'); // cách BE2 tạm dừng: đổi cờ sang 'paused'
        const u = await got;
        assert.ok(u, 'không nhận được auction:update khi tạm dừng');
        assert.strictEqual(u.paused, true);
        assert.strictEqual(u.status, 'active');
        assert.ok(u.pausedAt);
        assert.strictEqual(new Date(u.endsAt).getTime(), new Date(before.ends_at).getTime());
        assert.ok(u.remainingSeconds > 3500 && u.remainingSeconds <= 3600, `remainingSeconds ${u.remainingSeconds}`);
        assert.strictEqual(typeof u.currentPrice, 'number');

        await sleep(1200);
        const gotResume = waitFor(sA, 'auction:update', isFor(as, 'resumed'));
        await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f]);
        const r = await gotResume;
        assert.ok(r, 'không nhận được auction:update khi tiếp tục');
        assert.strictEqual(r.paused, false);
        assert.strictEqual(r.pausedAt, null);
        const shift = new Date(r.endsAt) - new Date(before.ends_at);
        assert.ok(shift >= 1000 && shift < 5000, `giờ kết thúc mới phải lùi đúng thời gian dừng, lùi ${shift}ms`);
        assert.strictEqual(new Date(r.endsAt).getTime(), new Date((await clock(as)).ends_at).getTime());
      });
      await step('auction:update khi đặt giá có reason bid; người ngoài phòng không nhận', async () => {
        const { auctionId: as } = await mkAuction(seller);
        const sA = await connect(tok(A, 'account', 'bidder'));
        const sB = await connect(tok(B, 'account', 'bidder')); // không vào phòng
        await joinRoom(sA, as);
        await engine.joinAuction({ bidderId: B, auctionId: as });
        const got = waitFor(sA, 'auction:update', isFor(as, 'bid'));
        const outside = waitFor(sB, 'auction:update', (u) => u.auctionId === String(as), 1500);
        await engine.placeBid({ bidderId: B, auctionId: as, increment: 50_000 });
        const u = await got;
        assert.ok(u);
        assert.deepStrictEqual([u.currentPrice, u.bidCount, u.bid.amount], [1_050_000, 1, 1_050_000]);
        assert.strictEqual(await outside, null);
      });
      await step('tạm dừng bị ROLLBACK thì không phát sự kiện; chấm dứt phiên đang dừng không phát "resumed"', async () => {
        const { auctionId: as } = await mkAuction(seller);
        const sA = await connect(tok(A, 'account', 'bidder'));
        await joinRoom(sA, as);
        const none = waitFor(sA, 'auction:update', (u) => u.auctionId === String(as), 2000);
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`INSERT INTO flagged_auctions (auction_id, severity, confidence, reason, status) VALUES ($1, 'high', 90, $2, 'paused')`, [as, `${PREFIX}rb`]);
          await c.query('ROLLBACK');
        } finally { c.release(); }
        assert.strictEqual(await none, null, 'giao dịch ROLLBACK không được phát auction:update');
        assert.strictEqual((await clock(as)).paused_at, null);

        const f = await flag(as, 'paused');
        assert.ok(await waitFor(sA, 'auction:update', isFor(as, 'paused')));
        const resumed = waitFor(sA, 'auction:update', isFor(as, 'resumed'), 2000);
        const ended = waitFor(sA, 'auction:ended', (e) => e.auctionId === String(as));
        const done = await tx(async (cl) => {
          const d = await engine.cancelAuction(cl, as);
          await cl.query(`UPDATE flagged_auctions SET status = 'terminated' WHERE id = $1`, [f]);
          return d;
        });
        done.emit();
        assert.deepStrictEqual(await ended, { auctionId: String(as), hasWinner: false, cancelled: true });
        assert.strictEqual(await resumed, null);
      });

      await step('disconnectAccount: báo lý do rồi ngắt mọi kết nối của tài khoản, trả về số kết nối', async () => {
        const s1 = await connect(tok(C, 'account', 'bidder'));
        const s2 = await connect(tok(C, 'account', 'bidder'));
        const other = await connect(tok(B, 'account', 'bidder'));
        const notices = [waitFor(s1, 'account:disconnected'), waitFor(s2, 'account:disconnected')];
        const closed = [waitFor(s1, 'disconnect'), waitFor(s2, 'disconnect')];
        const n = await registerSockets.disconnectAccount(C, { reason: 'Vi phạm điều khoản' });
        assert.strictEqual(n, 2);
        for (const p of notices) assert.deepStrictEqual(await p, { code: 'ACCOUNT_SUSPENDED', message: 'Vi phạm điều khoản' });
        for (const p of closed) assert.strictEqual(await p, 'io server disconnect');
        assert.strictEqual(other.connected, true, 'tài khoản khác không bị ngắt');
        assert.strictEqual(await registerSockets.disconnectAccount(C), 0); // không còn online
        assert.strictEqual(await registerSockets.disconnectAccount(null), 0);
      });
      await step('tài khoản bị khoá không kết nối lại được; token sai bị từ chối', async () => {
        await pool.query(`UPDATE accounts SET status = 'suspended' WHERE id = $1`, [C]);
        await assert.rejects(connect(tok(C, 'account', 'bidder')), { message: 'ACCOUNT_SUSPENDED' });
        await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [C]);
        const back = await connect(tok(C, 'account', 'bidder'));
        assert.strictEqual(back.connected, true);
        await assert.rejects(connect('token-sai'), { message: 'UNAUTHORIZED' });
        await assert.rejects(connect(tok('999999999', 'account', 'bidder')), { message: 'UNAUTHORIZED' });
      });
      await step('disconnectAccount với kind ops chỉ ngắt tài khoản nội bộ, không nhầm với account trùng id', async () => {
        const email = `${PREFIX}ops_${Date.now()}${DOMAIN}`;
        const opsId = (await pool.query(
          `INSERT INTO ops_accounts (name, email, role) VALUES ($1, $2, 'admin') RETURNING id`, [`${PREFIX}ops`, email])).rows[0].id;
        // ops_accounts.id có thể trùng số với A/B/C: đóng hết socket account để kiểm tra không bị nhiễu.
        sockets.forEach((s) => s.close());
        await sleep(300);
        const sOps = await connect(tok(opsId, 'ops', 'admin'));
        assert.strictEqual(await registerSockets.disconnectAccount(opsId), 0); // kind mặc định 'account'
        assert.strictEqual(sOps.connected, true);
        const notice = waitFor(sOps, 'account:disconnected');
        assert.strictEqual(await registerSockets.disconnectAccount(opsId, { kind: 'ops' }), 1);
        assert.deepStrictEqual(await notice, { code: 'ACCOUNT_SUSPENDED', message: 'Tài khoản đã bị tạm khoá' });
        await pool.query(`UPDATE ops_accounts SET status = 'suspended' WHERE id = $1`, [opsId]);
        await assert.rejects(connect(tok(opsId, 'ops', 'admin')), { message: 'ACCOUNT_SUSPENDED' });
      });
    } finally {
      sockets.forEach((s) => s.close());
      await pauseListener.stop();
      await new Promise((res) => server.close(res));
    }
  }

  console.log(`\nTất cả ${passed} bước đạt.`);
}

main()
  .catch((err) => { console.error('\n✗ THẤT BẠI:', err); process.exitCode = 1; })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup lỗi:', e.message));
    await cleanupOps().catch((e) => console.error('cleanup ops lỗi:', e.message));
    await pool.end();
  });
