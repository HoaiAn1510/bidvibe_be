// Kiểm thử end-to-end phần BE1 trên DB dùng chung bằng dữ liệu tạm có tiền tố riêng, kèm mã lần chạy:
//   tài khoản  email  test_be1_<mã lần chạy>_<tên>_<số>@be1test.local, họ tên  test_be1_<tên>
//   tin đăng   tiêu đề test_be1_<mã lần chạy>_item
// Mọi thao tác ghi/xoá chỉ chạm các dòng đi ra từ những tài khoản đó; dữ liệu thật và dữ
// liệu của người khác không bị sửa hay xoá. Cuối lần chạy (kể cả khi lỗi) chỉ dọn dữ liệu của
// CHÍNH lần chạy này; đầu lần chạy chỉ dọn dữ liệu test_be1_ bỏ dở từ hơn 30 phút trước, nên
// hai người chạy test cùng lúc trên database dùng chung không xoá dữ liệu của nhau.
// Chạy: npm run test:be1   (hoặc node scripts/test_be1.js)
// Supabase session pooler giới hạn tổng số kết nối của cả database (15): test dùng ít kết nối để
// chạy song song với lần chạy khác / test:be2 / server của đồng đội. Đặt trước khi nạp pool.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '4';
// /api/dev phải tắt trong tiến trình test dù .env của người chạy có bật DEV_TOOLS; phần test /api/dev tự bật cho server con.
process.env.DEV_TOOLS = 'false';
const assert = require('assert');
const { pool } = require('../src/config/db');
const engine = require('../src/services/auction_engine');
const walletService = require('../src/services/wallet_service');
const fraud = require('../src/services/fraud_detection');
// Giới hạn tốc độ đặt giá (1 lượt / giây / người) tắt trong các bước khác, vì chúng đặt giá liên tiếp nhanh bằng cùng một tài khoản;
// phần "Giới hạn tốc độ đặt giá" bên dưới bật lại để kiểm tra.
engine.limits.bidMinIntervalMs = 0;

const PREFIX = 'test_be1_';
const DOMAIN = '@be1test.local';
// Mã lần chạy: thời điểm bắt đầu (base36) + 3 ký tự ngẫu nhiên; chỉ gồm chữ thường và số.
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')}`;
const RUN = `${PREFIX}${RUN_ID}_`;
// LIKE: dấu _ là ký tự đại diện nên phải escape để chỉ khớp đúng tiền tố.
const like = (p) => p.replace(/_/g, '\\_');
const EMAIL_LIKE_ANY = `${like(PREFIX)}%${DOMAIN}`;
const EMAIL_LIKE_RUN = `${like(RUN)}%${DOMAIN}`;
const STALE_MS = 30 * 60_000;
// Thời điểm bắt đầu của lần chạy đã tạo email này; email kiểu cũ (không có mã) coi như rất cũ.
const runStartOf = (email) => {
  const m = /^test_be1_([0-9a-z]{9,})_/.exec(email);
  return m ? parseInt(m[1].slice(0, -3), 36) : 0;
};
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
  const email = `${RUN}${name.toLowerCase()}_${Math.floor(Math.random() * 1e6)}${DOMAIN}`;
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
     VALUES ($1, $2, $4, $3, 1, 'approved') RETURNING id`, [sellerId, cat, startPrice, `${RUN}item`]);
  const auctionId = await engine.inTransaction((c) => engine.createAuctionForListing(c, l.rows[0].id));
  return { listingId: l.rows[0].id, auctionId };
}

const wallet = async (id) => (await pool.query(
  'SELECT wallet_balance::int AS b, wallet_held::int AS h FROM bidders WHERE account_id = $1', [id])).rows[0];
const expire = (auctionId) => pool.query(`UPDATE auctions SET ends_at = now() - interval '1 second', starts_at = now() - interval '1 hour' WHERE id = $1`, [auctionId]);

// Chỉ xoá những dòng đi ra từ tài khoản test_be1_*: phiên của người bán test, và mọi dòng
// của người mua test. Không có điều kiện nào có thể khớp dữ liệu thật.
//   cleanup('run')   dữ liệu của lần chạy này
//   cleanup('stale') dữ liệu test_be1_ của các lần chạy bắt đầu hơn 30 phút trước (bị ngắt giữa chừng)
async function testRows(scope, table) {
  const { rows } = await pool.query(`SELECT id, email FROM ${table} WHERE email LIKE $1`,
    [scope === 'run' ? EMAIL_LIKE_RUN : EMAIL_LIKE_ANY]);
  return scope === 'run' ? rows : rows.filter((r) => Date.now() - runStartOf(r.email) > STALE_MS);
}

async function cleanup(scope) {
  const ids = (await testRows(scope, 'accounts')).map((r) => r.id);
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

async function cleanupOps(scope) {
  const ids = (await testRows(scope, 'ops_accounts')).map((r) => r.id);
  if (ids.length) await pool.query('DELETE FROM ops_accounts WHERE id = ANY($1)', [ids]);
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

// Chạy một server con `node src/app.js` như `npm run dev` của một người khác: cổng riêng, cùng DB, pool 2, có scheduler.
// Trả về { url, output(), stop() }; stop() chờ tiến trình thoát thật (đăng ký 'exit' ngay lúc tạo).
async function spawnApp(extraEnv = {}) {
  const { spawn } = require('child_process');
  const net = require('net');
  const path = require('path');
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'app.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_POOL_MAX: '2', NODE_ENV: 'development', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = () => { child.kill(); return exited; };
  for (const end = Date.now() + 20_000; !(out.includes('đang chạy tại') && out.includes('[realtime] đang nghe')); await new Promise((r) => setTimeout(r, 200))) {
    if (child.exitCode !== null) throw new Error(`server con thoát sớm: ${out.slice(-300)}`);
    if (Date.now() > end) { await stop(); throw new Error(`server con không sẵn sàng sau 20 giây. Output của server con:
${out.slice(-600)}`); }
  }
  return { url: `http://127.0.0.1:${port}`, stop, output: () => out };
}

async function main() {
  await cleanup('stale'); // lần chạy bị ngắt giữa chừng; không đụng lần chạy đang diễn ra của người khác
  await cleanupOps('stale');
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
    assert.ok(left > 25_000 && left <= 32_500, `còn ${left}ms`); // +2 giây phía trên: dung sai đồng hồ (xem chú thích ở bước tạm dừng)
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
  // serverTime: ISO 8601 UTC đúng định dạng, gần giờ máy chạy test (cùng máy với server test nên lệch rất ít).
  const assertServerTime = (obj, label = 'payload') => {
    assert.ok(obj, `${label}: không có dữ liệu`);
    const t = obj.serverTime;
    assert.strictEqual(typeof t, 'string', `${label}: thiếu serverTime`);
    assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t), `${label}: serverTime ${t}`);
    assert.strictEqual(new Date(t).toISOString(), t);
    assert.ok(Math.abs(Date.now() - Date.parse(t)) < 15_000, `${label}: serverTime ${t} lệch quá xa giờ hiện tại`);
  };
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
    // Dung sai ±2 giây quanh ~3 giây: remainingSeconds tính bằng giờ máy chạy test, còn ends_at / paused_at đặt bằng giờ DB;
    // hai đồng hồ lệch nhau (đo được ~0,4 giây) cộng độ trễ mạng tới Supabase. Vẫn đủ để bắt lỗi "đồng hồ không đứng" (sẽ về 0).
    assert.ok(view.remainingSeconds >= 0 && view.remainingSeconds <= 5, `còn ${view.remainingSeconds}s, mong ~3s (đứng yên)`);
    await engine.closeExpiredAuctions();
    assert.strictEqual((await clock(ap)).status, 'active', 'job đóng phiên không được đóng phiên đang tạm dừng');

    await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f]);
    const elapsed = Date.now() - t0;
    const after = await clock(ap);
    assert.strictEqual(after.paused_at, null);
    const shift = new Date(after.ends_at) - new Date(before.ends_at);
    // shift do DB tính, elapsed do giờ máy đo kèm vài lượt gọi tới DB: cho sai số 3,5 giây (trước 1,5 giây)
    assert.ok(Math.abs(shift - elapsed) < 3500, `ends_at dịch ${shift}ms, thời gian dừng ~${elapsed}ms`);
    assert.ok(new Date(after.ends_at) > new Date(Date.now() - 2000), 'tiếp tục xong thì phiên vẫn còn giờ, không đóng ngay'); // -2 giây: lệch đồng hồ máy / DB
    await engine.closeExpiredAuctions();
    assert.strictEqual((await clock(ap)).status, 'active');
    const resumed = await engine.getAuction(ap, A);
    assert.strictEqual(resumed.paused, false);
    assert.ok(resumed.remainingSeconds >= 0 && resumed.remainingSeconds <= 5, `còn ${resumed.remainingSeconds}s`); // ±2 giây, lý do như trên
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
    // Các luật theo danh tính (seller_affinity...) cũng có thể báo trên tài khoản test, nên không giả định chỉ có một luật:
    // mỗi LÝ DO đúng một cờ pending, tổng số cờ mới = số cờ pending, và cờ ping_pong có đúng một bộ bằng chứng.
    const pending = (await pool.query(`SELECT id, reason FROM flagged_auctions WHERE auction_id = $1 AND status = 'pending' ORDER BY id`, [af])).rows;
    assert.strictEqual(created.reduce((x, y) => x + y, 0), pending.length, `số cờ mới: ${created}, cờ pending: ${pending.map((r) => r.reason)}`);
    assert.strictEqual(new Set(pending.map((r) => r.reason)).size, pending.length, 'mỗi lý do chỉ một cờ pending');
    const pp = pending.filter((r) => r.reason.startsWith('Chỉ hai'));
    assert.strictEqual(pp.length, 1);
    const ev = await pool.query('SELECT count(*)::int AS n FROM flag_evidence WHERE flagged_auction_id = $1', [pp[0].id]);
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
    assert.ok(await fraud.scanAuction(ap) >= 1);
    const before = await flagsOf(ap);
    // Luật theo danh tính có thể thêm cờ mức thấp / vừa; báo cáo luôn gộp vào cờ nghiêm trọng nhất (ping_pong, high).
    const top = before.find((f) => f.reason.startsWith('Chỉ hai'));
    assert.strictEqual(top.severity, 'high');
    const r = await fraud.reportAuction({ reporterId: C, auctionId: ap, reason: 'Thấy hai người đặt qua lại' });
    assert.strictEqual(r.flagCreated, false);
    const after = await flagsOf(ap);
    assert.strictEqual(after.length, before.length, 'không tạo cờ mới');
    assert.strictEqual(after.find((f) => f.id === top.id).evidence, top.evidence + 1);
    for (const f of before.filter((x) => x.id !== top.id)) {
      assert.strictEqual(after.find((x) => x.id === f.id).evidence, f.evidence, 'cờ khác không bị thêm bằng chứng');
    }
  });
  await step('cùng một người báo cáo song song: chỉ một báo cáo được ghi', async () => {
    const { auctionId: ap } = await mkAuction(seller);
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => fraud.reportAuction({ reporterId: A, auctionId: ap, reason: 'Spam' })));
    assert.strictEqual(rs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'ALREADY_REPORTED'),
      JSON.stringify(rs.map((r) => r.status === 'fulfilled' ? 'ok' : (r.reason.code || r.reason.message))));
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

  console.log('Nhắc người thắng thanh toán và chọn địa chỉ giao hàng');
  {
    const addressService = require('../src/services/address_service');
    const fulfilment = require('../src/services/fulfilment_service');
    const D = await mkAccount('bidder', 'Dan');
    const E = await mkAccount('bidder', 'Eve');
    for (const id of [D, E]) await tx((c) => walletService.topUp(c, { bidderId: id, amount: 10_000_000 }));
    const notes = async (accountId, type) => (await pool.query(
      'SELECT title FROM notifications WHERE account_id = $1 AND type = $2 ORDER BY id', [accountId, type])).rows.map((r) => r.title);
    // Phiên kết thúc với `winner` thắng; trả về đơn của người thắng.
    const wonOrder = async (winner) => {
      const { auctionId: aw } = await mkAuction(seller);
      await engine.joinAuction({ bidderId: winner, auctionId: aw });
      await engine.placeBid({ bidderId: winner, auctionId: aw, increment: 50_000 });
      await expire(aw);
      await closedAuction(aw);
      return (await pool.query('SELECT id, payment_deadline FROM orders WHERE auction_id = $1', [aw])).rows[0];
    };

    await step('thắng phiên: thông báo win nhắc thanh toán trong 24 giờ và chọn địa chỉ, kèm mã đơn', async () => {
      const before = (await notes(D, 'win')).length;
      const o = await wonOrder(D);
      const wins = await notes(D, 'win');
      assert.strictEqual(wins.length, before + 1);
      const t = wins[wins.length - 1];
      assert.ok(t.includes(`Đơn #${o.id}`), t);
      assert.ok(/thanh toán trước \d{2}:\d{2} \d{2}\/\d{2} \(24 giờ\)/.test(t), t);
      assert.ok(t.includes('chọn địa chỉ giao hàng'), t);
      // Hạn trong thông báo khớp payment_deadline của đơn (giờ Việt Nam).
      const vn = new Date(new Date(o.payment_deadline).getTime() + 7 * 3600_000); // UTC+7, không có giờ mùa hè
      const hhmm = `${String(vn.getUTCHours()).padStart(2, '0')}:${String(vn.getUTCMinutes()).padStart(2, '0')} ${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}`;
      assert.ok(t.includes(hhmm), `${t} / ${hhmm}`);
    });
    await step('thanh toán xong mà đơn chưa có địa chỉ: một thông báo address_reminder', async () => {
      const o = await wonOrder(D);
      const before = await notes(D, 'address_reminder');
      const r = await engine.payOrder({ bidderId: D, orderId: o.id, method: 'wallet' });
      assert.deepStrictEqual(Object.keys(r).sort(), ['balanceAfter', 'orderId', 'paymentStatus', 'totalDue']); // phản hồi không đổi
      const after = await notes(D, 'address_reminder');
      assert.strictEqual(after.length, before.length + 1);
      assert.ok(after[after.length - 1].startsWith(`Đơn #${o.id} `), after[after.length - 1]);
      await rejects(engine.payOrder({ bidderId: D, orderId: o.id }), 'ALREADY_PAID');
      assert.strictEqual((await notes(D, 'address_reminder')).length, after.length, 'trả lại lần hai không được nhắc thêm');
    });
    await step('thanh toán song song cùng một đơn: một lượt thành công, đúng một lần nhắc', async () => {
      const o = await wonOrder(E);
      const before = (await notes(E, 'address_reminder')).length;
      const rs = await Promise.allSettled([1, 2, 3].map(() => engine.payOrder({ bidderId: E, orderId: o.id, method: 'wallet' })));
      assert.strictEqual(rs.filter((x) => x.status === 'fulfilled').length, 1);
      assert.ok(rs.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'ALREADY_PAID'));
      const mine = (await notes(E, 'address_reminder')).filter((t) => t.startsWith(`Đơn #${o.id} `));
      assert.strictEqual((await notes(E, 'address_reminder')).length, before + 1);
      assert.strictEqual(mine.length, 1);
    });
    await step('đơn đã chọn địa chỉ trước khi thanh toán: không nhắc', async () => {
      const addr = await addressService.create(E, {
        recipientName: `${PREFIX}Eve`, phone: '0901234567', addressLine: '1 Đường Test', city: 'TP.HCM',
      });
      const o = await wonOrder(E);
      await fulfilment.setShippingAddress(E, o.id, { addressId: addr.id }); // API của BE2, chỉ gọi
      const before = (await notes(E, 'address_reminder')).length;
      await engine.payOrder({ bidderId: E, orderId: o.id, method: 'wallet' });
      assert.strictEqual((await notes(E, 'address_reminder')).length, before);
    });
  }

  console.log('API cho các màn hình app (trường thêm mới)');
  {
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const addressService = require('../src/services/address_service');
    const fulfilment = require('../src/services/fulfilment_service');
    const { server } = require('../src/app');
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const tok = (id, role) => jwt.sign({ sub: String(id), kind: 'account', role }, env.jwtSecret, { expiresIn: '5m' });
    const get = async (path, token) => {
      const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
      const body = await r.json();
      assert.strictEqual(r.status, 200, JSON.stringify(body.error));
      return body.data;
    };
    try {
      const G = await mkAccount('bidder', 'Gil'); // 50.000đ: không đủ cọc 100.000đ
      await tx((c) => walletService.topUp(c, { bidderId: G, amount: 50_000 }));
      const H = await mkAccount('bidder', 'Hal');
      await tx((c) => walletService.topUp(c, { bidderId: H, amount: 5_000_000 }));
      const { listingId: lp, auctionId: ap } = await mkAuction(seller);
      const urls = ['https://example.com/test_be1_a.jpg', 'https://example.com/test_be1_b.jpg'];
      for (let i = 0; i < 2; i += 1) {
        await pool.query('INSERT INTO listing_photos (listing_id, url, order_index) VALUES ($1, $2, $3)', [lp, urls[i], i]);
      }

      await step('GET /api/auctions: total, limit, offset, minNextBid, seller.name, depositAffordable', async () => {
        const q = encodeURIComponent(RUN);
        const d = await get(`/auctions?q=${q}&limit=2&offset=0&sort=newest`, tok(H, 'bidder'));
        const n = (await pool.query(
          `SELECT count(*)::int AS n FROM auctions a JOIN listings l ON l.id = a.listing_id WHERE l.title ILIKE $1`, [`%${like(RUN)}%`])).rows[0].n;
        assert.deepStrictEqual([d.total, d.limit, d.offset], [n, 2, 0]);
        assert.ok(n > 2 && d.auctions.length === 2, 'trang đầu chỉ 2 phần tử, total là tổng thật');
        const page2 = await get(`/auctions?q=${q}&limit=2&offset=2&sort=newest`, tok(H, 'bidder'));
        assert.strictEqual(page2.total, n);
        assert.ok(!page2.auctions.some((x) => d.auctions.some((y) => y.id === x.id)), 'hai trang không trùng phần tử');

        const it = d.auctions.find((x) => x.id === String(ap));
        assert.ok(it, 'phiên mới nhất phải ở trang đầu (sort=newest)');
        assert.strictEqual(it.minNextBid, it.currentPrice + it.bidStep);
        assert.strictEqual(it.coverUrl, urls[0]);
        assert.deepStrictEqual([it.seller.storeName, it.seller.name], ['Test shop', 'Test shop']);
        assert.strictEqual(it.depositAffordable, true);
        for (const k of ['currentPrice', 'bidStep', 'bidCount', 'endsAt', 'remainingSeconds', 'status']) assert.ok(k in it, k);

        const g = (await get(`/auctions?q=${q}&limit=50`, tok(G, 'bidder'))).auctions.find((x) => x.id === String(ap));
        assert.strictEqual(g.depositAffordable, false);
        const s = (await get(`/auctions?q=${q}&limit=50`, tok(seller, 'seller'))).auctions.find((x) => x.id === String(ap));
        assert.strictEqual(s.depositAffordable, null); // không phải bidder
      });
      await step('GET /api/auctions/:id: photos đủ, ảnh bìa đứng đầu, giá tối thiểu tiếp theo', async () => {
        await engine.joinAuction({ bidderId: H, auctionId: ap });
        await engine.placeBid({ bidderId: H, auctionId: ap, increment: 50_000 });
        const d = await get(`/auctions/${ap}`, tok(H, 'bidder'));
        assert.deepStrictEqual(d.photos.map((p) => [p.url, p.orderIndex]), [[urls[0], 0], [urls[1], 1]]);
        assert.strictEqual(d.coverUrl, d.photos[0].url);
        assert.deepStrictEqual([d.joined, d.leading, d.myDeposit, d.minNextBid], [true, true, 100_000, 1_100_000]);
        assert.deepStrictEqual([d.bids[0].who, d.bids[0].me], ['T***', true]); // tên đã che: "test_be1_Hal" -> "T***"
      });
      await step('serverTime: GET /api/auctions và /:id có serverTime ở cấp data, không lặp trong từng phiên', async () => {
        const list = await get(`/auctions?q=${encodeURIComponent(RUN)}&limit=2`, tok(H, 'bidder'));
        assertServerTime(list, 'GET /auctions');
        assert.ok(list.auctions.length > 0 && list.auctions.every((x) => !('serverTime' in x)), 'serverTime không được lặp trong từng phiên');
        const d = await get(`/auctions/${ap}`, tok(H, 'bidder'));
        assertServerTime(d, 'GET /auctions/:id');
        assert.ok(d.bids.every((b) => !('serverTime' in b)));
        assert.ok(['id', 'currentPrice', 'endsAt', 'remainingSeconds', 'photos', 'bids'].every((k) => k in d), 'các trường cũ vẫn còn');
        const d2 = await get(`/auctions/${ap}`, tok(H, 'bidder'));
        assert.ok(Date.parse(d2.serverTime) >= Date.parse(d.serverTime), 'serverTime không được lùi');
      });
      await step('GET /api/wallet/transactions: kindLabel tiếng Việt, total, phân trang', async () => {
        const d = await get('/wallet/transactions?limit=1&offset=0', tok(H, 'bidder'));
        const n = (await pool.query('SELECT count(*)::int AS n FROM wallet_transactions WHERE bidder_id = $1', [H])).rows[0].n;
        assert.deepStrictEqual([d.total, d.limit, d.offset, d.transactions.length], [n, 1, 0, 1]);
        assert.deepStrictEqual([d.transactions[0].kind, d.transactions[0].kindLabel], ['deposit_hold', 'Giữ cọc tham gia phiên']);
        const all = await get('/wallet/transactions', tok(H, 'bidder'));
        assert.ok(all.transactions.every((t) => typeof t.kindLabel === 'string' && t.kindLabel !== t.kind));
      });
      await step('GET /api/orders/mine và /:id: người bán, ảnh bìa, địa chỉ giao hàng', async () => {
        await expire(ap);
        await closedAuction(ap);
        let o = (await get('/orders/mine', tok(H, 'bidder'))).orders.find((x) => x.auctionId === String(ap));
        assert.ok(o);
        assert.deepStrictEqual([o.seller.name, o.coverUrl, o.shippingAddress], ['Test shop', urls[0], null]);
        assert.ok(o.paymentDeadline && o.amountToPay > 0 && o.paymentStatus === 'awaiting_payment');
        const addr = await addressService.create(H, {
          recipientName: `${PREFIX}Hal`, phone: '0901234567', addressLine: '2 Đường Test', ward: 'P.1', district: 'Q.1', city: 'TP.HCM',
        });
        await fulfilment.setShippingAddress(H, o.id, { addressId: addr.id });
        o = await get(`/orders/${o.id}`, tok(H, 'bidder'));
        assert.deepStrictEqual(o.shippingAddress, {
          id: addr.id, recipientName: `${PREFIX}Hal`, phone: '0901234567', addressLine: '2 Đường Test',
          ward: 'P.1', district: 'Q.1', city: 'TP.HCM',
        });
      });
    } finally {
      await new Promise((res) => server.close(res));
    }
  }

  console.log('Script demo:bidbot (giả lập người đấu giá qua API thật)');
  {
    const bcrypt = require('bcrypt');
    const { runBidbot } = require('./demo_bidbot');
    const { server } = require('../src/app');
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const PW = `${PREFIX}pw`;
    const hash = await bcrypt.hash(PW, 4);
    // Tài khoản test đăng nhập được (mật khẩu thật) — bot không đụng tài khoản demo thật trong test.
    const mkLoginBidder = async (name, money) => {
      const id = await mkAccount('bidder', name);
      await pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [id, hash]);
      if (money) await tx((c) => walletService.topUp(c, { bidderId: id, amount: money }));
      const email = (await pool.query('SELECT email FROM accounts WHERE id = $1', [id])).rows[0].email;
      return { id, email, password: PW };
    };
    const logs = [];
    const log = (m) => logs.push(m);
    try {
      const b1 = await mkLoginBidder('BotOne', 5_000_000);
      const b2 = await mkLoginBidder('BotTwo', 5_000_000);
      const poor = await mkLoginBidder('BotPoor', 150_000); // đủ cọc 100.000 nhưng không đủ trả đơn nếu thắng
      const allowedEmails = [b1.email, b2.email, poor.email];

      await step('bot đặt cọc rồi trả giá luân phiên qua API, dừng khi đủ --max lượt', async () => {
        const { auctionId: ab } = await mkAuction(seller); // 1.000.000đ, bước 50.000
        const r = await runBidbot({ base, auctionId: ab, accounts: [b1, b2], intervalMs: 50, max: 4, log, allowedEmails });
        assert.deepStrictEqual(r, { bids: 4, reason: 'đủ 4 lượt' });
        const rows = (await pool.query('SELECT bidder_id, amount::int AS a FROM bids WHERE auction_id = $1 ORDER BY id', [ab])).rows;
        assert.deepStrictEqual(rows.map((x) => x.a), [1_050_000, 1_100_000, 1_150_000, 1_200_000]);
        assert.ok(rows.every((x, i) => i === 0 || String(x.bidder_id) !== String(rows[i - 1].bidder_id)), 'hai bot xen kẽ');
        const deps = (await pool.query('SELECT count(*)::int AS n FROM auction_deposits WHERE auction_id = $1', [ab])).rows[0].n;
        assert.strictEqual(deps, 2); // mỗi bot cọc một lần
      });
      await step('bot không đủ tiền trả đơn nếu thắng thì không cọc, không trả giá; không còn bot hợp lệ thì dừng', async () => {
        const { auctionId: ab } = await mkAuction(seller);
        const before = await wallet(poor.id);
        const r = await runBidbot({ base, auctionId: ab, accounts: [poor], intervalMs: 50, max: 3, log, allowedEmails });
        assert.strictEqual(r.bids, 0);
        assert.ok(r.reason.startsWith('không bot nào đủ điều kiện'), r.reason);
        assert.deepStrictEqual(await wallet(poor.id), before, 'ví không đổi');
      });
      await step('bot dừng khi phiên hết giờ và khi nhận tín hiệu dừng (Ctrl+C)', async () => {
        const { auctionId: ab } = await mkAuction(seller);
        await expire(ab);
        assert.deepStrictEqual(await runBidbot({ base, auctionId: ab, accounts: [b1], intervalMs: 50, max: 3, log, allowedEmails }),
          { bids: 0, reason: 'phiên đã kết thúc' });
        const { auctionId: ab2 } = await mkAuction(seller);
        const r = await runBidbot({ base, auctionId: ab2, accounts: [b1, b2], intervalMs: 50, max: 10, log, allowedEmails, stopSignal: { stop: true } });
        assert.deepStrictEqual(r, { bids: 0, reason: 'dừng theo yêu cầu (Ctrl+C)' });
      });
      await step('script từ chối chạy khi NODE_ENV=production, báo lỗi khi thiếu --auction', async () => {
        const { spawnSync } = require('child_process');
        const run = (args, extraEnv) => spawnSync(process.execPath, ['scripts/demo_bidbot.js', ...args], {
          cwd: require('path').join(__dirname, '..'), env: { ...process.env, ...extraEnv }, encoding: 'utf8',
        });
        const prod = run(['--auction', '1'], { NODE_ENV: 'production' });
        assert.strictEqual(prod.status, 1);
        assert.ok(prod.stderr.includes('NODE_ENV=production'), prod.stderr);
        const noArg = run([], { NODE_ENV: 'development' });
        assert.strictEqual(noArg.status, 1);
        assert.ok(noArg.stderr.includes('--auction'), noArg.stderr);
        // Chỉ định tài khoản không phải bot (kể cả tài khoản demo của người dùng) -> từ chối trước khi gọi API.
        const other = run(['--auction', '1', '--bots', 'bot1@bidvibe.demo,minhanh@gmail.com'], { NODE_ENV: 'development' });
        assert.strictEqual(other.status, 1);
        assert.ok(other.stderr.includes('minhanh@gmail.com') && other.stderr.includes('Từ chối'), other.stderr);
      });
      await step('bot chỉ dùng tài khoản được phép; thiếu / sai tài khoản bot thì từ chối, không ghi gì', async () => {
        const { auctionId: ab } = await mkAuction(seller);
        const r1 = await runBidbot({ base, auctionId: ab, accounts: [b1], intervalMs: 50, max: 3, log }); // mặc định: chỉ 3 bot demo
        assert.strictEqual(r1.bids, 0);
        assert.ok(r1.reason.startsWith('từ chối: chỉ được dùng tài khoản bot') && r1.reason.includes(b1.email), r1.reason);
        const r2 = await runBidbot({ base, auctionId: ab, accounts: [{ email: b1.email, password: 'sai' }], intervalMs: 50, max: 3, log, allowedEmails });
        assert.ok(r2.reason.startsWith('từ chối: không đăng nhập được tài khoản bot'), r2.reason);
        const n = (await pool.query('SELECT count(*)::int AS n FROM auction_deposits WHERE auction_id = $1', [ab])).rows[0].n;
        assert.strictEqual(n, 0);
      });
      await step('bot không trả giá khi phiên còn dưới --stop-before giây (hạn chế bot thắng)', async () => {
        const { auctionId: ab } = await mkAuction(seller);
        await pool.query(`UPDATE auctions SET ends_at = now() + interval '50 seconds' WHERE id = $1`, [ab]);
        const r = await runBidbot({ base, auctionId: ab, accounts: [b1, b2], intervalMs: 50, max: 3, log, allowedEmails, stopBeforeSeconds: 60 });
        assert.deepStrictEqual(r, { bids: 0, reason: 'phiên còn dưới 60 giây, bot dừng để không thắng phiên' });
      });
      await step('bot với interval mặc định 5 giây không bị giới hạn tốc độ đặt giá (1 lượt / giây / người)', async () => {
        engine.limits.bidMinIntervalMs = 1000;
        try {
          const { auctionId: ab } = await mkAuction(seller);
          const r = await runBidbot({ base, auctionId: ab, accounts: [b1, b2], intervalMs: 5000, max: 2, log, allowedEmails, stopBeforeSeconds: 60 });
          assert.deepStrictEqual(r, { bids: 2, reason: 'đủ 2 lượt' });
          const n = (await pool.query('SELECT count(DISTINCT bidder_id)::int AS n FROM bids WHERE auction_id = $1', [ab])).rows[0].n;
          assert.strictEqual(n, 2, 'hai bot luân phiên đều đặt được');
        } finally { engine.limits.bidMinIntervalMs = 0; }
      });
      await step('--only-outbid: chỉ trả giá khi người khác dẫn đầu, bot dẫn đầu rồi thì chờ', async () => {
        const { auctionId: ab } = await mkAuction(seller);
        const stopAfter = (ms) => { const sig = { stop: false }; setTimeout(() => { sig.stop = true; }, ms); return sig; };
        // Chưa ai đặt giá: bot chờ, không đặt.
        let r = await runBidbot({ base, auctionId: ab, accounts: [b1, b2], intervalMs: 50, max: 5, log, allowedEmails, onlyOutbid: true, stopSignal: stopAfter(400) });
        assert.strictEqual(r.bids, 0);
        // Người thật (không phải bot) đặt giá -> bot vượt đúng một lần rồi chờ vì bot đang dẫn đầu.
        const human = await mkAccount('bidder', 'Human');
        await tx((c) => walletService.topUp(c, { bidderId: human, amount: 5_000_000 }));
        await engine.joinAuction({ bidderId: human, auctionId: ab });
        await engine.placeBid({ bidderId: human, auctionId: ab, increment: 50_000 });
        // Chờ có vòng lặp thay vì ngủ cố định: kiểm tra mỗi 300 ms (tối đa 10 giây) tới khi bot đã vượt giá,
        // rồi chờ thêm một nhịp để chắc bot không đặt lần hai (bot dẫn đầu thì phải chờ).
        const sig = { stop: false };
        const running = runBidbot({ base, auctionId: ab, accounts: [b1, b2], intervalMs: 50, max: 5, log, allowedEmails, onlyOutbid: true, stopSignal: sig });
        const bidCount = async () => (await pool.query('SELECT count(*)::int AS n FROM bids WHERE auction_id = $1', [ab])).rows[0].n;
        for (let waited = 0; waited < 10_000 && (await bidCount()) < 2; waited += 300) await sleep(300);
        await sleep(300);
        sig.stop = true;
        r = await running;
        assert.deepStrictEqual(r, { bids: 1, reason: 'dừng theo yêu cầu (Ctrl+C)' });
        const last = (await pool.query('SELECT amount::int AS a FROM bids WHERE auction_id = $1 ORDER BY id DESC LIMIT 1', [ab])).rows[0].a;
        assert.strictEqual(last, 1_100_000);
      });
    } finally {
      await new Promise((res) => server.close(res));
    }
  }

  console.log('Thông báo của BE1 có data (GET /api/notifications và Socket.io notification:new)');
  {
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const { io: ioClient } = require('socket.io-client');
    const { server } = require('../src/app');
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const url = `http://127.0.0.1:${server.address().port}`;
    const tok = (id, role) => jwt.sign({ sub: String(id), kind: 'account', role }, env.jwtSecret, { expiresIn: '5m' });
    const sockets = [];
    // Kết nối socket cho một tài khoản và gom mọi notification:new nhận được.
    const listen = (id, role) => new Promise((resolve, reject) => {
      const s = ioClient(url, { auth: { token: tok(id, role) }, transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(s);
      s.got = [];
      s.on('notification:new', (n) => s.got.push(n));
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
    });
    const latestApi = async (id, role, type) => {
      const r = await fetch(`${url}/api/notifications?limit=50`, { headers: { Authorization: `Bearer ${tok(id, role)}` } });
      const body = await r.json();
      assert.strictEqual(r.status, 200, JSON.stringify(body.error));
      return body.data.notifications.find((n) => n.type === type);
    };
    // data đúng tập khoá, mọi giá trị là chuỗi, khớp giá trị mong đợi; API và socket giống nhau.
    const checkData = async ({ id, role, sock, type, expect }) => {
      const api = await latestApi(id, role, type);
      assert.ok(api, `không có thông báo ${type} qua API`);
      assert.deepStrictEqual(Object.keys(api.data).sort(), Object.keys(expect).sort(), `${type}: khoá ${JSON.stringify(api.data)}`);
      for (const [k, v] of Object.entries(api.data)) assert.strictEqual(typeof v, 'string', `${type}.${k} phải là chuỗi`);
      assert.deepStrictEqual(api.data, expect);
      await sleep(300);
      const ev = [...sock.got].reverse().find((n) => n.type === type);
      assert.ok(ev, `không nhận được notification:new ${type}`);
      assert.deepStrictEqual(ev.data, expect, `${type}: socket ${JSON.stringify(ev.data)}`);
      assert.strictEqual(String(ev.id), String(api.id));
    };

    try {
      const W = await mkAccount('bidder', 'Win');
      const L = await mkAccount('bidder', 'Lose');
      const S = await mkAccount('seller', 'Sel');
      for (const id of [W, L]) await tx((c) => walletService.topUp(c, { bidderId: id, amount: 5_000_000 }));
      const [sW, sL, sS] = [await listen(W, 'bidder'), await listen(L, 'bidder'), await listen(S, 'seller')];

      await step('đặt giá → đóng phiên → thanh toán: outbid, win, refund (thua), sold, address_reminder có data đúng khoá', async () => {
        const { auctionId: a1 } = await mkAuction(S);
        for (const id of [W, L]) await engine.joinAuction({ bidderId: id, auctionId: a1 });
        await engine.placeBid({ bidderId: L, auctionId: a1, increment: 50_000 });
        await engine.placeBid({ bidderId: W, auctionId: a1, increment: 50_000 });
        await checkData({ id: L, role: 'bidder', sock: sL, type: 'outbid', expect: { auctionId: String(a1) } });

        await expire(a1);
        await engine.closeAuction(a1); // gọi ngay sau khi hết giờ để thông báo phát từ server của test này
        const o = (await pool.query('SELECT id FROM orders WHERE auction_id = $1', [a1])).rows[0];
        assert.ok(o, 'phải có đơn');
        const both = { auctionId: String(a1), orderId: String(o.id) };
        await checkData({ id: W, role: 'bidder', sock: sW, type: 'win', expect: both });
        await checkData({ id: L, role: 'bidder', sock: sL, type: 'refund', expect: { auctionId: String(a1) } });
        await checkData({ id: S, role: 'seller', sock: sS, type: 'sold', expect: both });

        await engine.payOrder({ bidderId: W, orderId: o.id, method: 'wallet' });
        await checkData({ id: W, role: 'bidder', sock: sW, type: 'address_reminder', expect: { orderId: String(o.id), auctionId: String(a1) } });
      });
      await step('mỗi loại win / sold / address_reminder chỉ ghi đúng một thông báo cho luồng trên', async () => {
        const types = (await pool.query(
          `SELECT type, count(*)::int AS n FROM notifications WHERE account_id = ANY($1) AND type IN ('win','sold','address_reminder')
           GROUP BY type ORDER BY type`, [[W, S]])).rows;
        assert.deepStrictEqual(types, [{ type: 'address_reminder', n: 1 }, { type: 'sold', n: 1 }, { type: 'win', n: 1 }]);
      });
      await step('refund khi huỷ phiên (cancelAuction) có data { auctionId }', async () => {
        const { auctionId: a2 } = await mkAuction(S);
        await engine.joinAuction({ bidderId: L, auctionId: a2 });
        const done = await tx((c) => engine.cancelAuction(c, a2, { reason: 'test' }));
        done.emit();
        await checkData({ id: L, role: 'bidder', sock: sL, type: 'refund', expect: { auctionId: String(a2) } });
      });
      await step('warn quá hạn thanh toán (processPaymentTimeouts) có data { orderId, auctionId }', async () => {
        const { auctionId: a3 } = await mkAuction(S);
        await engine.joinAuction({ bidderId: L, auctionId: a3 });
        await engine.placeBid({ bidderId: L, auctionId: a3, increment: 50_000 });
        await expire(a3);
        await engine.closeAuction(a3);
        // Scheduler của server khác (npm run dev của đồng đội) có thể đóng phiên / xử lý quá hạn trước
        // test: hàm của test bỏ qua dòng đang bị khoá (SKIP LOCKED). Chờ tối đa 10 giây, mỗi 300ms
        // đọc lại, cho tới khi DB về đúng trạng thái; không giả định ai là người xử lý.
        const waitFor = async (read, what) => {
          for (const end = Date.now() + 10_000; ; await sleep(300)) {
            const v = await read();
            if (v) return v;
            assert.ok(Date.now() < end, `${what} sau 10 giây`);
          }
        };
        const o = await waitFor(async () => (await pool.query('SELECT id FROM orders WHERE auction_id = $1', [a3])).rows[0],
          'không có đơn của phiên vừa đóng');
        await pool.query(`UPDATE orders SET payment_deadline = now() - interval '1 minute' WHERE id = $1`, [o.id]);
        const mine = (await engine.processPaymentTimeouts()).map(String).includes(String(o.id));
        const expect = { orderId: String(o.id), auctionId: String(a3) };
        if (mine) {
          // Test tự xử lý đơn: kiểm đủ API và socket như các loại thông báo khác.
          await checkData({ id: L, role: 'bidder', sock: sL, type: 'warn', expect });
        } else {
          // Server khác xử lý: notification:new phát trên Socket.io của server đó, socket của test không
          // nhận được; vẫn kiểm đủ khoá, kiểu và giá trị data qua API.
          const api = await waitFor(() => latestApi(L, 'bidder', 'warn'), 'không có thông báo warn qua API');
          assert.deepStrictEqual(Object.keys(api.data).sort(), Object.keys(expect).sort(), `warn: khoá ${JSON.stringify(api.data)}`);
          for (const [k, v] of Object.entries(api.data)) assert.strictEqual(typeof v, 'string', `warn.${k} phải là chuỗi`);
          assert.deepStrictEqual(api.data, expect);
        }
        const warn = await latestApi(L, 'bidder', 'warn');
        assert.ok(warn.title.startsWith('Quá hạn thanh toán'), `warn: tiêu đề ${warn.title}`);
        // Trạng thái cuối: đơn quá hạn, tin bị huỷ, cọc bị tịch thu (có giao dịch deposit_forfeit).
        const st = await waitFor(async () => (await pool.query(
          `SELECT o.payment_status, l.status AS listing_status, d.status AS deposit_status,
                  (SELECT count(*)::int FROM wallet_transactions w
                   WHERE w.bidder_id = o.bidder_id AND w.related_auction_id = o.auction_id AND w.kind = 'deposit_forfeit') AS forfeits
           FROM orders o JOIN auctions a ON a.id = o.auction_id JOIN listings l ON l.id = a.listing_id
           LEFT JOIN auction_deposits d ON d.auction_id = o.auction_id AND d.bidder_id = o.bidder_id
           WHERE o.id = $1 AND o.payment_status = 'expired'`, [o.id])).rows[0], 'đơn chưa chuyển quá hạn');
        assert.deepStrictEqual(st, { payment_status: 'expired', listing_status: 'cancelled', deposit_status: 'forfeited', forfeits: 1 });
      });
      await step('thông báo cũ data = null vẫn đọc được qua API', async () => {
        await pool.query(`INSERT INTO notifications (account_id, type, title) VALUES ($1, 'outbid', $2)`, [W, `${PREFIX}cũ`]);
        const r = await fetch(`${url}/api/notifications?limit=50`, { headers: { Authorization: `Bearer ${tok(W, 'bidder')}` } });
        const body = await r.json();
        assert.strictEqual(r.status, 200);
        const old = body.data.notifications.find((n) => n.title === `${PREFIX}cũ`);
        assert.strictEqual(old.data, null);
      });
    } finally {
      sockets.forEach((s) => s.close());
      await new Promise((res) => server.close(res));
    }
  }

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
        // endsAt = giờ máy chạy test + 1 giờ (createAuctionForListing) còn pausedAt là now() của DB, nên máy lệch
        // DB khoảng 1 giây thì ra 3601. Cho sai số +2 giây, và kiểm tra thêm remainingSeconds khớp đúng hai mốc trong chính sự kiện.
        assert.ok(u.remainingSeconds > 3500 && u.remainingSeconds <= 3602, `remainingSeconds ${u.remainingSeconds}`);
        assert.strictEqual(u.remainingSeconds, Math.ceil((new Date(u.endsAt) - new Date(u.pausedAt)) / 1000));
        assert.strictEqual(typeof u.currentPrice, 'number');

        await sleep(1200);
        const gotResume = waitFor(sA, 'auction:update', isFor(as, 'resumed'));
        await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f]);
        const r = await gotResume;
        assert.ok(r, 'không nhận được auction:update khi tiếp tục');
        assert.strictEqual(r.paused, false);
        assert.strictEqual(r.pausedAt, null);
        const shift = new Date(r.endsAt) - new Date(before.ends_at);
        // Thời gian dừng thật >= 1,2 giây (sleep) nhưng cho dung sai ±2 giây: chỉ cần lùi về sau và không quá xa
        assert.ok(shift > 0 && shift < 7000, `giờ kết thúc mới phải lùi đúng thời gian dừng, lùi ${shift}ms`);
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
      await step('serverTime: có trong auction:update (bid, paused, resumed) và auction:ended', async () => {
        const { auctionId: as } = await mkAuction(seller);
        const sA = await connect(tok(A, 'account', 'bidder'));
        await joinRoom(sA, as);
        await engine.joinAuction({ bidderId: B, auctionId: as });
        const bid = waitFor(sA, 'auction:update', isFor(as, 'bid'));
        await engine.placeBid({ bidderId: B, auctionId: as, increment: 50_000 });
        assertServerTime(await bid, 'auction:update bid');
        const paused = waitFor(sA, 'auction:update', isFor(as, 'paused'));
        const f = await flag(as, 'paused');
        assertServerTime(await paused, 'auction:update paused');
        const resumed = waitFor(sA, 'auction:update', isFor(as, 'resumed'));
        await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f]);
        assertServerTime(await resumed, 'auction:update resumed');
        const ended = waitFor(sA, 'auction:ended', (e) => e.auctionId === String(as));
        await expire(as);
        await closedAuction(as);
        const e = await ended;
        assertServerTime(e, 'auction:ended');
        assert.deepStrictEqual([e.auctionId, e.hasWinner], [String(as), true]); // các trường cũ giữ nguyên
      });
      await step('auction:viewers: đếm theo tài khoản (vào, rời, ngắt kết nối; hai kết nối cùng tài khoản tính 1) và GET /api/auctions/:id có viewers', async () => {
        const { auctionId: av } = await mkAuction(seller);
        const sA = await connect(tok(A, 'account', 'bidder'));
        const sB = await connect(tok(B, 'account', 'bidder'));
        const sA2 = await connect(tok(A, 'account', 'bidder')); // cùng tài khoản A, kết nối thứ hai
        const viewersIs = (s, n) => waitFor(s, 'auction:viewers', (v) => v.auctionId === String(av) && v.viewers === n);
        const restViewers = async () => {
          const r = await fetch(`${url}/api/auctions/${av}`, { headers: { Authorization: `Bearer ${tok(A, 'account', 'bidder')}` } });
          const body = await r.json();
          assert.strictEqual(r.status, 200, JSON.stringify(body.error));
          return body.data.viewers;
        };
        assert.strictEqual(await restViewers(), 0, 'chưa ai vào phòng');

        let w = viewersIs(sA, 1);
        sA.emit('auction:join', String(av));
        const first = await w;
        assert.deepStrictEqual(Object.keys(first).sort(), ['auctionId', 'viewers']); // payload đúng hai trường
        assert.strictEqual(typeof first.viewers, 'number');

        w = viewersIs(sA, 2);
        const wB = viewersIs(sB, 2);
        sB.emit('auction:join', av); // số (không phải chuỗi) vẫn vào đúng phòng
        assert.ok(await w, 'A không nhận viewers = 2 khi B vào');
        assert.ok(await wB, 'B không nhận viewers = 2 khi tự vào');
        assert.strictEqual(await restViewers(), 2);

        // Cùng tài khoản mở thêm kết nối: vẫn tính 1.
        const dup = waitFor(sA, 'auction:viewers', (v) => v.auctionId === String(av), 1500);
        sA2.emit('auction:join', String(av));
        const d = await dup; // sự kiện vẫn được phát nhưng số không đổi
        assert.ok(d && d.viewers === 2, `A mở 2 kết nối: mong viewers 2, nhận ${d && d.viewers}`);
        assert.strictEqual(await restViewers(), 2);

        w = viewersIs(sA, 1);
        sB.emit('auction:leave', String(av));
        assert.ok(await w, 'A không nhận viewers = 1 khi B rời');
        assert.strictEqual(await restViewers(), 1);

        // B vào lại rồi ngắt kết nối (đóng socket): các socket còn lại nhận số mới.
        w = viewersIs(sA, 2);
        sB.emit('auction:join', String(av));
        assert.ok(await w);
        w = viewersIs(sA, 1);
        sB.close();
        assert.ok(await w, 'A không nhận viewers = 1 khi B ngắt kết nối');
        assert.strictEqual(await restViewers(), 1);

        // A có hai kết nối: đóng một thì vẫn còn 1 người xem; đóng nốt thì 0.
        sA.close();
        await sleep(500);
        assert.strictEqual(await restViewers(), 1, 'A còn một kết nối trong phòng');
        sA2.close();
        await sleep(500);
        assert.strictEqual(await restViewers(), 0);
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

        const pausedEv = waitFor(sA, 'auction:update', isFor(as, 'paused')); // đăng ký trước khi tạm dừng, kẻo lỡ sự kiện đến sớm
        const f = await flag(as, 'paused');
        assert.ok(await pausedEv);
        const resumed = waitFor(sA, 'auction:update', isFor(as, 'resumed'), 2000);
        const ended = waitFor(sA, 'auction:ended', (e) => e.auctionId === String(as));
        const done = await tx(async (cl) => {
          const d = await engine.cancelAuction(cl, as);
          await cl.query(`UPDATE flagged_auctions SET status = 'terminated' WHERE id = $1`, [f]);
          return d;
        });
        done.emit();
        const { serverTime, ...endedFields } = await ended; // serverTime kiểm ở bước riêng; các trường cũ giữ nguyên
        assertServerTime({ serverTime }, 'auction:ended huỷ phiên');
        assert.deepStrictEqual(endedFields, { auctionId: String(as), hasWinner: false, cancelled: true });
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
        const email = `${RUN}ops_${Math.floor(Math.random() * 1e6)}${DOMAIN}`;
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

  console.log('Đồng hồ theo giờ database');
  {
    const dbClock = require('../src/config/db_clock');
    const dbNow = async () => new Date((await pool.query('SELECT clock_timestamp() AS t')).rows[0].t);
    const endsAtOf = async (id) => new Date((await clock(id)).ends_at).getTime();
    await step('chống chốt phút chót theo giờ DB: còn ≤ 30 giây thì ends_at = giờ DB + 30 giây; còn > 30 giây không đổi', async () => {
      const { auctionId: ax } = await mkAuction(seller);
      await engine.joinAuction({ bidderId: A, auctionId: ax });
      await engine.joinAuction({ bidderId: B, auctionId: ax });
      // Còn lâu mới hết: không gia hạn, ends_at giữ nguyên từng micro giây.
      const before = await endsAtOf(ax);
      let r = await engine.placeBid({ bidderId: B, auctionId: ax, increment: 50_000 });
      assert.strictEqual(r.extended, false);
      assert.strictEqual(new Date(r.endsAt).getTime(), before);
      // Còn 10 giây: gia hạn đúng 30 giây tính từ giờ DB lúc đặt giá. endsAt <= giờ DB đo SAU đó + 30 giây (không dung sai).
      await pool.query(`UPDATE auctions SET ends_at = clock_timestamp() + interval '10 seconds' WHERE id = $1`, [ax]);
      r = await engine.placeBid({ bidderId: A, auctionId: ax, increment: 50_000 });
      const after = await dbNow();
      assert.strictEqual(r.extended, true);
      const left = new Date(r.endsAt) - after;
      assert.ok(left <= 30_000 && left > 27_000, `còn ${left}ms sau gia hạn, mong trong (27000, 30000]`);
      assert.strictEqual(new Date(r.endsAt).getTime(), await endsAtOf(ax), 'ends_at trong DB khớp giá trị trả về');
      // Còn 31 giây (> 30): không gia hạn, ends_at giữ nguyên.
      await pool.query(`UPDATE auctions SET ends_at = clock_timestamp() + interval '31 seconds' WHERE id = $1`, [ax]);
      const set = await endsAtOf(ax);
      r = await engine.placeBid({ bidderId: B, auctionId: ax, increment: 50_000 });
      assert.strictEqual(r.extended, false);
      assert.strictEqual(new Date(r.endsAt).getTime(), set);
    });
    await step('hết giờ tính theo giờ DB: ends_at vừa qua thì đặt cọc / đặt giá bị từ chối AUCTION_ENDED (phiên chưa kịp đóng)', async () => {
      const { auctionId: ax } = await mkAuction(seller);
      await engine.joinAuction({ bidderId: A, auctionId: ax });
      await pool.query(`UPDATE auctions SET ends_at = clock_timestamp() - interval '1 second', starts_at = now() - interval '1 hour' WHERE id = $1`, [ax]);
      await rejects(engine.placeBid({ bidderId: A, auctionId: ax, increment: 50_000 }), 'AUCTION_ENDED');
      await rejects(engine.joinAuction({ bidderId: B, auctionId: ax }), 'AUCTION_ENDED');
      assert.strictEqual((await clock(ax)).status, 'active', 'chưa có ai đóng phiên');
    });
    await step('remainingSeconds tính trong SQL theo giờ DB: khớp ends_at - giờ DB, đứng yên khi tạm dừng, 0 khi đã kết thúc', async () => {
      const { auctionId: ax } = await mkAuction(seller);
      await pool.query(`UPDATE auctions SET ends_at = clock_timestamp() + interval '40 seconds', starts_at = now() - interval '1 hour' WHERE id = $1`, [ax]);
      const v = await engine.getAuction(ax, A);
      assert.ok(v.remainingSeconds >= 38 && v.remainingSeconds <= 40, `remainingSeconds ${v.remainingSeconds}`);
      const f = await flag(ax, 'paused');
      const p1 = (await engine.getAuction(ax, A)).remainingSeconds;
      await sleep(1500);
      const p2 = (await engine.getAuction(ax, A)).remainingSeconds;
      assert.strictEqual(p1, p2, 'đang tạm dừng thì remainingSeconds đứng yên');
      assert.ok(p1 >= 38 && p1 <= 40, `remainingSeconds khi dừng ${p1}`);
      await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f]);
      await expire(ax);
      await closedAuction(ax);
      assert.strictEqual((await engine.getAuction(ax, A)).remainingSeconds, 0);
    });
    await step('tạo phiên: starts_at / ends_at theo giờ DB (ends_at - starts_at = thời lượng tin đăng)', async () => {
      const { auctionId: ax } = await mkAuction(seller);
      const r = (await pool.query(
        `SELECT (ends_at - starts_at) = interval '1 hour' AS exact,
                abs(extract(epoch FROM (clock_timestamp() - starts_at))) AS age FROM auctions WHERE id = $1`, [ax])).rows[0];
      assert.strictEqual(r.exact, true);
      assert.ok(Number(r.age) < 60, `starts_at lệch giờ DB ${r.age}s`);
    });
    await step('db_clock: đo độ lệch giờ DB, đo lỗi thì giữ độ lệch cũ và không ném lỗi; serverTime = giờ máy + độ lệch', async () => {
      assert.strictEqual(await dbClock.measure(), true);
      const dbT = await dbNow();
      assert.ok(Math.abs(dbClock.serverNow() - dbT) < 1500, `serverNow lệch giờ DB ${dbClock.serverNow() - dbT}ms`);
      const kept = dbClock.getOffsetMs();
      assert.strictEqual(await dbClock.measure({ query: async () => { throw new Error('mất kết nối'); } }), false);
      assert.strictEqual(dbClock.getOffsetMs(), kept, 'đo lỗi phải giữ độ lệch cũ');
      dbClock.setOffsetForTest(5000);
      try {
        const lead = Date.parse(dbClock.serverTimeIso()) - Date.now();
        assert.ok(lead > 4500 && lead < 5500, `serverTime phải đi trước giờ máy ~5000ms, nhận ${lead}ms`);
      } finally { dbClock.setOffsetForTest(0); }
    });
  }

  console.log('Scheduler: chỉ một backend làm việc tại một thời điểm (khoá advisory)');
  {
    const { Client } = require('pg');
    const env = require('../src/config/env');
    const { SCHEDULER_LOCK_KEY } = require('../src/services/scheduler');
    const apps = [];
    let holder = null;
    // Phiên đã hết giờ, người dẫn đầu P, chờ scheduler đóng.
    const expiredAuction = async (P) => {
      const { auctionId } = await mkAuction(seller);
      await engine.joinAuction({ bidderId: P, auctionId });
      await engine.placeBid({ bidderId: P, auctionId, increment: 50_000 });
      await expire(auctionId);
      return auctionId;
    };
    const status = async (id) => (await pool.query('SELECT status FROM auctions WHERE id = $1', [id])).rows[0].status;
    const untilEnded = async (id, ms = 30_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if ((await status(id)) !== 'active') return true;
      return false;
    };
    // Dòng log đóng phiên có dạng "[scheduler] đã đóng 2 phiên (#12, #13)": đếm số dòng nhắc tới #id.
    const closedBy = (app, id) => app.output().split('\n').filter((l) => l.includes('đã đóng') && (l.includes(`#${id})`) || l.includes(`#${id},`))).length;
    const closedLogs = (id) => apps.reduce((n, app) => n + closedBy(app, id), 0);
    try {
      const P = await mkAccount('bidder', 'SchedP');
      await tx((c) => walletService.topUp(c, { bidderId: P, amount: 5_000_000 }));
      // Một "backend khác" đang giữ khoá scheduler: kết nối riêng giữ pg_advisory_lock. Giữ TRƯỚC khi hai server con
      // khởi động, kẻo lượt tick đầu tiên của chúng (chạy ngay lúc khởi động) lấy được khoá trước.
      holder = new Client({ connectionString: env.databaseUrl, ssl: env.dbSsl ? { rejectUnauthorized: false } : false });
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock($1)', [SCHEDULER_LOCK_KEY]);
      const [A1, B1] = [await spawnApp(), await spawnApp()];
      apps.push(A1, B1);

      const a1 = await expiredAuction(P);
      await step('khoá đang bị giữ: cả hai backend bỏ lượt, phiên hết giờ chưa bị đóng (qua ít nhất 2 lượt tick)', async () => {
        await sleep(14_000);
        assert.strictEqual(await status(a1), 'active', 'khoá đang bị giữ mà phiên vẫn bị đóng');
        assert.strictEqual(closedLogs(a1), 0);
        for (const a of apps) assert.ok(!a.output().includes('đang làm scheduler chính'), a.output());
      });

      await step('nhả khoá (backend giữ khoá tắt): phiên được đóng đúng một lần, có đúng một đơn, có log scheduler chính', async () => {
        await holder.end(); // đóng kết nối = Postgres tự nhả khoá phiên
        holder = null;
        assert.ok(await untilEnded(a1), 'phiên không được đóng sau khi nhả khoá');
        await sleep(6000); // chờ thêm một lượt tick của cả hai backend: không được đóng lần hai
        assert.strictEqual(closedLogs(a1), 1, `phiên #${a1} được log đóng ${closedLogs(a1)} lần`);
        const orders = (await pool.query('SELECT bidder_id FROM orders WHERE auction_id = $1', [a1])).rows;
        assert.deepStrictEqual(orders.map((o) => String(o.bidder_id)), [String(P)]);
        assert.ok(apps.some((a) => a.output().includes('backend này đang làm scheduler chính')), 'không backend nào log làm scheduler chính');
      });

      await step('tắt một backend: backend còn lại vẫn đóng được phiên kế tiếp, vẫn chỉ một đơn', async () => {
        await A1.stop();
        const a2 = await expiredAuction(P);
        assert.ok(await untilEnded(a2), 'backend còn lại không đóng được phiên kế tiếp');
        assert.strictEqual(closedLogs(a2), 1);
        assert.strictEqual(closedBy(B1, a2), 1, 'phiên kế tiếp phải do backend còn lại đóng');
        assert.strictEqual(closedBy(A1, a2), 0, 'backend đã tắt không được đóng phiên');
        assert.strictEqual((await pool.query('SELECT 1 FROM orders WHERE auction_id = $1', [a2])).rowCount, 1);
      });
    } finally {
      if (holder) await holder.end().catch(() => {});
      await Promise.all(apps.map((a) => a.stop()));
    }
  }

  console.log('Giới hạn tốc độ đặt giá');
  {
    const X = await mkAccount('bidder', 'RateX');
    const Y = await mkAccount('bidder', 'RateY');
    for (const id of [X, Y]) await tx((c) => walletService.topUp(c, { bidderId: id, amount: 5_000_000 }));
    const bidCountOf = async (id) => (await pool.query('SELECT bid_count FROM auctions WHERE id = $1', [id])).rows[0].bid_count;
    try {
      const { auctionId: a1 } = await mkAuction(seller);
      const { auctionId: a2 } = await mkAuction(seller);
      for (const id of [X, Y]) for (const a of [a1, a2]) await engine.joinAuction({ bidderId: id, auctionId: a });

      await step('hai lượt liên tiếp của cùng một người (kể cả phiên khác nhau): lượt 2 bị 429 BID_TOO_FAST, không ghi gì', async () => {
        engine.limits.bidMinIntervalMs = 30_000; // ngưỡng lớn để kết quả không phụ thuộc tốc độ mạng tới DB
        await engine.placeBid({ bidderId: Y, auctionId: a1, increment: 50_000 });
        const before = await bidCountOf(a2);
        await assert.rejects(engine.placeBid({ bidderId: Y, auctionId: a2, increment: 50_000 }),
          (e) => e.code === 'BID_TOO_FAST' && e.statusCode === 429 && e.message === 'Bạn đặt giá quá nhanh, vui lòng thử lại sau giây lát');
        assert.strictEqual(await bidCountOf(a2), before, 'lượt bị từ chối không được ghi');
        // Người khác không bị ảnh hưởng.
        await engine.placeBid({ bidderId: X, auctionId: a2, increment: 50_000 });
      });
      await step('chờ quá ngưỡng 1 giây thì đặt được', async () => {
        engine.limits.bidMinIntervalMs = 1000;
        await sleep(1200); // lượt giá của Y ở bước trước đã cũ hơn 1 giây
        const r = await engine.placeBid({ bidderId: Y, auctionId: a2, increment: 50_000 });
        assert.ok(r.bidId);
        // Hai chiều của ngưỡng kiểm bằng created_at của lượt vừa rồi (không phụ thuộc tốc độ mạng). X vượt Y ở phiên kia
        // trước, để Y không còn là người dẫn đầu (ALREADY_LEADING được kiểm trước giới hạn tốc độ).
        await engine.placeBid({ bidderId: X, auctionId: a1, increment: 50_000 });
        await pool.query(`UPDATE bids SET created_at = clock_timestamp() + interval '1 hour' WHERE id = $1`, [r.bidId]);
        await assert.rejects(engine.placeBid({ bidderId: Y, auctionId: a1, increment: 50_000 }), { code: 'BID_TOO_FAST' });
        await pool.query(`UPDATE bids SET created_at = clock_timestamp() - interval '1100 milliseconds' WHERE id = $1`, [r.bidId]);
        const r2 = await engine.placeBid({ bidderId: Y, auctionId: a1, increment: 50_000 });
        assert.ok(r2.bidId);
      });
    } finally {
      engine.limits.bidMinIntervalMs = 0;
    }
  }

  console.log('Phạt người hay bỏ đơn (2 cọc bị tịch thu trong 30 ngày: chặn tham gia 7 ngày)');
  {
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const { server } = require('../src/app');
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const tokOf = (id) => jwt.sign({ sub: String(id), kind: 'account', role: 'bidder' }, env.jwtSecret, { expiresIn: '5m' });
    const walletApi = async (id) => {
      const r = await fetch(`${base}/wallet`, { headers: { Authorization: `Bearer ${tokOf(id)}` } });
      const body = await r.json();
      assert.strictEqual(r.status, 200, JSON.stringify(body.error));
      return body.data;
    };
    // Một lần bỏ đơn: cọc một phiên rồi bị tịch thu qua đúng luồng ví (deposit_forfeit) và đánh dấu cọc forfeited.
    const forfeitOnce = async (id) => {
      const { auctionId } = await mkAuction(seller);
      const j = await engine.joinAuction({ bidderId: id, auctionId });
      await pool.query(`UPDATE auction_deposits SET status = 'forfeited' WHERE auction_id = $1 AND bidder_id = $2`, [auctionId, id]);
      await tx((c) => walletService.forfeitDeposit(c, { bidderId: id, auctionId, amount: j.deposit }));
    };
    const freshAuction = async () => (await mkAuction(seller)).auctionId;
    const ageForfeits = (id, interval) => pool.query(
      `UPDATE wallet_transactions SET created_at = clock_timestamp() - $2::interval WHERE bidder_id = $1 AND kind = 'deposit_forfeit'`, [id, interval]);
    const latestForfeit = async (id) => new Date((await pool.query(
      `SELECT max(created_at) AS t FROM wallet_transactions WHERE bidder_id = $1 AND kind = 'deposit_forfeit'`, [id])).rows[0].t);
    // Giờ Việt Nam (UTC+7, không có giờ mùa hè) dạng "HH:mm dd/MM/yyyy" như trong message.
    const vnText = (d) => {
      const v = new Date(d.getTime() + 7 * 3600_000);
      const z = (n) => String(n).padStart(2, '0');
      return `${z(v.getUTCHours())}:${z(v.getUTCMinutes())} ${z(v.getUTCDate())}/${z(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`;
    };
    try {
      const Z = await mkAccount('bidder', 'Skipper');
      await tx((c) => walletService.topUp(c, { bidderId: Z, amount: 5_000_000 }));

      await step('chưa bỏ đơn lần nào, và mới 1 lần bị tịch thu cọc: vẫn tham gia được, joinBlockedUntil = null', async () => {
        assert.strictEqual((await walletApi(Z)).joinBlockedUntil, null);
        await forfeitOnce(Z);
        assert.strictEqual((await walletApi(Z)).joinBlockedUntil, null);
        assert.ok((await engine.joinAuction({ bidderId: Z, auctionId: await freshAuction() })).depositId);
      });
      await step('2 lần tịch thu trong 30 ngày: 403 JOIN_BLOCKED, message có ngày giờ được tham gia lại (giờ Việt Nam); GET /api/wallet có joinBlockedUntil', async () => {
        await forfeitOnce(Z);
        const until = new Date((await latestForfeit(Z)).getTime() + 7 * 86400_000);
        const target = await freshAuction();
        const before = (await wallet(Z));
        await assert.rejects(engine.joinAuction({ bidderId: Z, auctionId: target }), (e) => {
          assert.strictEqual(e.code, 'JOIN_BLOCKED');
          assert.strictEqual(e.statusCode, 403);
          assert.ok(e.message.includes(vnText(until)), `${e.message} / ${vnText(until)}`);
          return true;
        });
        assert.deepStrictEqual(await wallet(Z), before, 'bị chặn thì không giữ cọc');
        assert.strictEqual((await pool.query('SELECT 1 FROM auction_deposits WHERE auction_id = $1 AND bidder_id = $2', [target, Z])).rowCount, 0);
        const w = await walletApi(Z);
        assert.strictEqual(new Date(w.joinBlockedUntil).getTime(), until.getTime());
        assert.deepStrictEqual(Object.keys(w).sort(), ['available', 'balance', 'held', 'joinBlockedUntil']); // chỉ thêm trường mới
      });
      await step('hết 7 ngày kể từ lần tịch thu gần nhất thì tham gia lại được (lần tịch thu cách đây 8 ngày)', async () => {
        await ageForfeits(Z, '8 days');
        assert.strictEqual((await walletApi(Z)).joinBlockedUntil, null);
        assert.ok((await engine.joinAuction({ bidderId: Z, auctionId: await freshAuction() })).depositId);
      });
      await step('lần tịch thu cũ hơn 30 ngày không tính: 1 cũ (40 ngày) + 1 mới thì không bị chặn', async () => {
        const Z2 = await mkAccount('bidder', 'SkipperTwo');
        await tx((c) => walletService.topUp(c, { bidderId: Z2, amount: 5_000_000 }));
        await forfeitOnce(Z2);
        await ageForfeits(Z2, '40 days');
        await forfeitOnce(Z2);
        assert.strictEqual((await walletApi(Z2)).joinBlockedUntil, null);
        assert.ok((await engine.joinAuction({ bidderId: Z2, auctionId: await freshAuction() })).depositId);
      });
      await step('2 lần trong 30 ngày (29 ngày trước và hôm qua): bị chặn đến 7 ngày sau lần gần nhất', async () => {
        const Z3 = await mkAccount('bidder', 'SkipperThree');
        await tx((c) => walletService.topUp(c, { bidderId: Z3, amount: 5_000_000 }));
        await forfeitOnce(Z3);
        await ageForfeits(Z3, '29 days');
        await forfeitOnce(Z3);
        await pool.query(
          `UPDATE wallet_transactions SET created_at = clock_timestamp() - interval '1 day'
           WHERE id = (SELECT max(id) FROM wallet_transactions WHERE bidder_id = $1 AND kind = 'deposit_forfeit')`, [Z3]);
        const until = new Date((await latestForfeit(Z3)).getTime() + 7 * 86400_000);
        await rejects(engine.joinAuction({ bidderId: Z3, auctionId: await freshAuction() }), 'JOIN_BLOCKED');
        assert.strictEqual(new Date((await walletApi(Z3)).joinBlockedUntil).getTime(), until.getTime());
      });
    } finally {
      await new Promise((res) => server.close(res));
    }
  }

  console.log('Đối soát ví (npm run wallet:check)');
  {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const { checkWallets, parseArgs } = require('./wallet_check');
    const bidders = {};
    for (const n of ['ChkWin', 'ChkQr', 'ChkLose', 'ChkSkip']) {
      bidders[n] = await mkAccount('bidder', n);
      await tx((c) => walletService.topUp(c, { bidderId: bidders[n], amount: 5_000_000 }));
    }
    const ids = Object.values(bidders);
    const closedWithWinner = async (winner, loser) => { // trả { auctionId, orderId }
      const { auctionId } = await mkAuction(seller);
      await engine.joinAuction({ bidderId: winner, auctionId });
      if (loser) { await engine.joinAuction({ bidderId: loser, auctionId }); await engine.placeBid({ bidderId: loser, auctionId, increment: 50_000 }); }
      await engine.placeBid({ bidderId: winner, auctionId, increment: 50_000 });
      await expire(auctionId);
      await closedAuction(auctionId);
      return { auctionId, orderId: (await pool.query('SELECT id FROM orders WHERE auction_id = $1', [auctionId])).rows[0].id };
    };
    const probs = async (list = ids) => (await checkWallets({ bidderIds: list })).problems;
    const cli = (list) => spawnSync(process.execPath, [path.join(__dirname, 'wallet_check.js'), `--bidder-ids=${list.join(',')}`],
      { encoding: 'utf8', env: { ...process.env, DB_POOL_MAX: '1' } });

    await step('đủ các loại giao dịch (nạp, giữ, hoàn, tịch thu, thanh toán bằng ví và bằng QR, hoàn tiền): không báo lệch', async () => {
      const w1 = await closedWithWinner(bidders.ChkWin, bidders.ChkLose);            // người thua được hoàn cọc
      await engine.payOrder({ bidderId: bidders.ChkWin, orderId: w1.orderId, method: 'wallet' });
      const w2 = await closedWithWinner(bidders.ChkQr, null);
      await engine.payOrder({ bidderId: bidders.ChkQr, orderId: w2.orderId, method: 'qr' }); // cổng ngoài: ví không bị trừ
      const w3 = await closedWithWinner(bidders.ChkSkip, null);                       // thắng rồi bỏ đơn
      await pool.query(`UPDATE orders SET payment_deadline = now() - interval '1 minute' WHERE id = $1`, [w3.orderId]);
      await engine.processPaymentTimeouts();
      for (let i = 0; i < 20; i += 1) { // có thể backend khác xử lý trước: chờ DB đúng trạng thái
        if ((await pool.query('SELECT payment_status FROM orders WHERE id = $1', [w3.orderId])).rows[0].payment_status === 'expired') break;
        await sleep(250);
      }
      await tx((c) => walletService.refund(c, { bidderId: bidders.ChkWin, amount: 70_000, auctionId: w1.auctionId }));
      // Một cọc đang giữ và một đơn thắng chưa thanh toán (applied_to_payment + awaiting_payment) vẫn phải khớp.
      const { auctionId: live } = await mkAuction(seller);
      await engine.joinAuction({ bidderId: bidders.ChkLose, auctionId: live });
      await closedWithWinner(bidders.ChkLose, null);
      const r = await checkWallets({ bidderIds: ids });
      assert.strictEqual(r.wallets, 4);
      assert.deepStrictEqual(r.problems, []);
    });

    await step('phát hiện số dư lệch (wallet_balance +1), tiền giữ lệch (wallet_held +7), sổ giao dịch bị sửa (amount +1)', async () => {
      const w = bidders.ChkWin;
      await pool.query('UPDATE bidders SET wallet_balance = wallet_balance + 1 WHERE account_id = $1', [w]);
      let p = await probs();
      assert.deepStrictEqual([...new Set(p.map((x) => x.check))], ['balance']);
      assert.ok(p.every((x) => x.bidderId === String(w) && x.diff === '1'), JSON.stringify(p));
      await pool.query('UPDATE bidders SET wallet_balance = wallet_balance - 1 WHERE account_id = $1', [w]);

      await pool.query('UPDATE bidders SET wallet_held = wallet_held + 7 WHERE account_id = $1', [w]);
      p = await probs();
      assert.deepStrictEqual([...new Set(p.map((x) => x.check))].sort(), ['held_deposits', 'held_ledger']);
      await pool.query('UPDATE bidders SET wallet_held = wallet_held - 7 WHERE account_id = $1', [w]);

      const tid = (await pool.query(`SELECT min(id) AS id FROM wallet_transactions WHERE bidder_id = $1 AND kind = 'topup'`, [w])).rows[0].id;
      await pool.query('UPDATE wallet_transactions SET amount = amount + 1 WHERE id = $1', [tid]);
      p = await probs();
      assert.ok(p.some((x) => x.check === 'balance_chain' && x.detail.includes(`#${tid}`)), JSON.stringify(p));
      await pool.query('UPDATE wallet_transactions SET amount = amount - 1 WHERE id = $1', [tid]);
      assert.deepStrictEqual(await probs(), [], 'khôi phục xong thì khớp lại');
    });

    await step('lệnh wallet:check: exit 0 khi khớp, exit 1 và in bảng khi lệch; chỉ đọc (không sửa dữ liệu); tham số sai bị từ chối', async () => {
      const ok = cli(ids);
      assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
      assert.ok(ok.stdout.includes('Đối soát 4 ví: 4 khớp, 0 lệch'), ok.stdout);
      const w = bidders.ChkQr;
      await pool.query('UPDATE bidders SET wallet_balance = wallet_balance + 5 WHERE account_id = $1', [w]);
      const before = (await wallet(w));
      const bad = cli(ids);
      assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
      assert.ok(bad.stdout.includes('balance') && bad.stdout.includes(String(w)) && bad.stdout.includes('1 lệch'), bad.stdout);
      assert.deepStrictEqual(await wallet(w), before, 'wallet:check không được sửa dữ liệu');
      await pool.query('UPDATE bidders SET wallet_balance = wallet_balance - 5 WHERE account_id = $1', [w]);
      assert.throws(() => parseArgs(['--bidder-ids=abc']), /danh sách id số/);
      assert.throws(() => parseArgs(['--sai']), /Tham số không hợp lệ/);
    });
  }

  console.log('Luật gian lận theo danh tính người đặt giá (seller_alt_account, seller_affinity, repeat_forfeiter)');
  {
    const R1 = 'Người đặt giá trùng số điện thoại với người bán';
    const R2 = 'Tài khoản gần như chỉ đặt giá phiên của một người bán';
    const R3 = 'Người dẫn đầu từng thắng rồi bỏ không thanh toán';
    const flagsOf = async (auctionId, reason) => {
      const f = (await pool.query(
        'SELECT id, severity, confidence, reason, status FROM flagged_auctions WHERE auction_id = $1 AND reason = $2 ORDER BY id', [auctionId, reason])).rows;
      for (const row of f) {
        row.evidence = (await pool.query('SELECT label, value FROM flag_evidence WHERE flagged_auction_id = $1 ORDER BY id', [row.id])).rows;
      }
      return f;
    };
    // Lượt giá trong tiến trình test; scanAuction chạy lại một cách tường minh (placeBid cũng tự quét nền sau đó).
    const bidAndScan = async (bidderId, auctionId) => {
      await engine.joinAuction({ bidderId, auctionId }).catch((e) => { if (e.code !== 'ALREADY_JOINED') throw e; });
      await engine.placeBid({ bidderId, auctionId, increment: 50_000 });
      await fraud.scanAuction(auctionId);
    };
    const seller2 = await mkAccount('seller', 'ShillSeller');
    await pool.query('UPDATE accounts SET phone = $2 WHERE id = $1', [seller2, '0901 234 567']);
    const mkFunded = async (name, phone = null) => {
      const id = await mkAccount('bidder', name);
      if (phone) await pool.query('UPDATE accounts SET phone = $2 WHERE id = $1', [id, phone]);
      await tx((c) => walletService.topUp(c, { bidderId: id, amount: 5_000_000 }));
      return id;
    };

    await step('seller_alt_account: người bán "0901 234 567" và người mua "+84901234567" -> đúng 1 cờ high/90, bằng chứng che số; đặt giá thêm không sinh cờ trùng', async () => {
      const X = await mkFunded('ShillX', '+84901234567');
      const Y = await mkFunded('ShillY', '0377 111 222');
      const { auctionId } = await mkAuction(seller2);
      await bidAndScan(X, auctionId);
      let f = await flagsOf(auctionId, R1);
      assert.strictEqual(f.length, 1);
      assert.deepStrictEqual([f[0].severity, f[0].confidence], ['high', 90]);
      assert.deepStrictEqual(f[0].evidence, [
        { label: `Tài khoản #${X} · số điện thoại trùng (đã che)`, value: '090****567' },
        { label: `Tài khoản #${X} · số lượt giá trong phiên`, value: '1' },
      ]);
      const text = JSON.stringify(f);
      for (const leak of ['0901234567', '901234567', '234567', '+84', '@', '0901 234 567']) assert.ok(!text.includes(leak), `bằng chứng lộ "${leak}": ${text}`);
      // Đặt giá thêm (cả người khác) và quét nhiều lần: vẫn đúng một cờ.
      await bidAndScan(Y, auctionId);
      await bidAndScan(X, auctionId);
      await fraud.scanAuction(auctionId);
      await sleep(1500); // các lần quét nền của placeBid
      f = await flagsOf(auctionId, R1);
      assert.strictEqual(f.length, 1, `có ${f.length} cờ seller_alt_account`);
      assert.strictEqual(f[0].evidence.length, 2, 'không thêm bằng chứng trùng');
    });
    await step('seller_alt_account KHÔNG báo nhầm: số điện thoại khác, hoặc người bán / người mua chưa có số', async () => {
      const Z = await mkFunded('ShillZ', '0911 234 567');
      const { auctionId: a1 } = await mkAuction(seller2);
      await bidAndScan(Z, a1);
      assert.strictEqual((await flagsOf(a1, R1)).length, 0, 'số khác nhau');
      const noPhoneSeller = await mkAccount('seller', 'NoPhoneSeller');
      const W = await mkFunded('ShillW'); // không có số
      const { auctionId: a2 } = await mkAuction(noPhoneSeller);
      await bidAndScan(W, a2);
      assert.strictEqual((await flagsOf(a2, R1)).length, 0, 'cả hai đều không có số điện thoại');
    });

    await step('repeat_forfeiter: người dẫn đầu từng bị tịch thu cọc -> cờ low/60, bằng chứng có số lần và lần gần nhất; người chưa bỏ đơn thì không báo', async () => {
      const F = await mkFunded('ShillForfeit');
      const G = await mkFunded('ShillGood');
      const { auctionId: dead } = await mkAuction(seller2);
      const j = await engine.joinAuction({ bidderId: F, auctionId: dead });
      await pool.query(`UPDATE auction_deposits SET status = 'forfeited' WHERE auction_id = $1 AND bidder_id = $2`, [dead, F]);
      await tx((c) => walletService.forfeitDeposit(c, { bidderId: F, auctionId: dead, amount: j.deposit }));
      const last = new Date((await pool.query(`SELECT max(created_at) AS t FROM wallet_transactions WHERE bidder_id = $1 AND kind = 'deposit_forfeit'`, [F])).rows[0].t);
      const { auctionId } = await mkAuction(seller2);
      await bidAndScan(F, auctionId);
      const f = await flagsOf(auctionId, R3);
      assert.strictEqual(f.length, 1);
      assert.deepStrictEqual([f[0].severity, f[0].confidence], ['low', 60]);
      const v = new Date(last.getTime() + 7 * 3600_000); // giờ Việt Nam (UTC+7)
      const z = (n) => String(n).padStart(2, '0');
      assert.deepStrictEqual(f[0].evidence.map((e) => e.value), ['1', `${z(v.getUTCHours())}:${z(v.getUTCMinutes())} ${z(v.getUTCDate())}/${z(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`]);
      // Người đã từng bỏ đơn nhưng bị vượt giá: người dẫn đầu mới (chưa bỏ đơn) -> không còn cờ mới cho phiên khác.
      const { auctionId: other } = await mkAuction(seller2);
      await bidAndScan(G, other);
      assert.strictEqual((await flagsOf(other, R3)).length, 0, 'người dẫn đầu chưa từng bỏ đơn');
      await bidAndScan(F, other); // F vượt G và dẫn đầu -> được báo ở phiên này
      assert.strictEqual((await flagsOf(other, R3)).length, 1);
    });

    await step('seller_affinity: đặt giá 3 phiên khác nhau của cùng người bán (100% lượt giá) -> cờ medium/70; rải thêm sang người bán khác (75%) hoặc mới 2 phiên thì không báo', async () => {
      const H = await mkFunded('ShillHooked');
      const J = await mkFunded('ShillSpread');
      const [s1, s2, s3] = [await mkAuction(seller2), await mkAuction(seller2), await mkAuction(seller2)];
      await bidAndScan(H, s1.auctionId);
      await bidAndScan(H, s2.auctionId);
      assert.strictEqual((await flagsOf(s2.auctionId, R2)).length, 0, 'mới 2 phiên của người bán');
      await bidAndScan(H, s3.auctionId);
      const f = await flagsOf(s3.auctionId, R2);
      assert.strictEqual(f.length, 1);
      assert.deepStrictEqual([f[0].severity, f[0].confidence], ['medium', 70]);
      assert.deepStrictEqual(f[0].evidence.map((e) => e.value), ['3', '100% (3/3 lượt)', '0']);
      assert.ok(!JSON.stringify(f).includes('@'), 'bằng chứng không ghi email');
      // J: 3 lượt ở người bán này + 1 lượt ở người bán khác = 75% < 80%
      const { auctionId: o1 } = await mkAuction(seller);
      await bidAndScan(J, o1);
      for (let i = 0; i < 3; i += 1) {
        const { auctionId } = await mkAuction(seller2);
        await bidAndScan(J, auctionId);
        assert.strictEqual((await flagsOf(auctionId, R2)).length, 0, `phiên ${i + 1} của người bán: tỉ lệ dưới 80%`);
      }
    });
  }

  console.log('API dev /api/dev (DEV_TOOLS): tắt thì 404, bật thì rút ngắn phiên và cho đơn quá hạn');
  {
    const { spawn } = require('child_process');
    const net = require('net');
    const path = require('path');
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const { io: ioClient } = require('socket.io-client');
    const tok = (id, kind, role) => jwt.sign({ sub: String(id), kind, role }, env.jwtSecret, { expiresIn: '5m' });
    const freePort = () => new Promise((resolve, reject) => {
      const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
    // Server con `node src/app.js` (có scheduler, như npm run dev) với biến môi trường tuỳ chọn.
    const children = [];
    const startServer = async (extraEnv) => {
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'app.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), DB_POOL_MAX: '2', NODE_ENV: 'development', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      children.push({ child, exited });
      for (const end = Date.now() + 20_000; !(out.includes('đang chạy tại') && out.includes('[realtime] đang nghe')); await sleep(200)) {
        if (child.exitCode !== null) throw new Error(`server dev thoát sớm: ${out.slice(-300)}`);
        if (Date.now() > end) throw new Error(`server dev không sẵn sàng sau 20 giây. Output của server con:
${out.slice(-600)}`);
      }
      // Đăng ký 'exit' ngay lúc tạo: tiến trình bị kill bằng tín hiệu có exitCode = null và sự kiện không phát lại,
      // nên chờ 'exit' sau khi đã tắt sẽ treo mãi và Node thoát im lặng với mã 0 (bỏ qua phần test còn lại).
      const stop = () => { child.kill(); return exited; };
      return { url: `http://127.0.0.1:${port}`, stop, exited, output: () => out };
    };
    const call = async (url, method, p, token, body) => {
      const r = await fetch(url + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, ...(await r.json()) };
    };
    const waitFor = (s, event, pred = () => true, ms = 8000) => new Promise((resolve) => {
      const timer = setTimeout(() => { s.off(event, h); resolve(null); }, ms);
      function h(data) { if (pred(data)) { clearTimeout(timer); s.off(event, h); resolve(data ?? true); } }
      s.on(event, h);
    });
    // Chờ DB đạt điều kiện (scheduler của server con làm việc đóng phiên / huỷ đơn mỗi 5 giây).
    const until = async (sql, params, pred, ms = 30_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
        const row = (await pool.query(sql, params)).rows[0];
        if (row && pred(row)) return row;
      }
      return null;
    };
    const sockets = [];

    try {
      const P = await mkAccount('bidder', 'DevP');
      const Q = await mkAccount('bidder', 'DevQ');
      for (const id of [P, Q]) await tx((c) => walletService.topUp(c, { bidderId: id, amount: 5_000_000 }));
      const tokP = tok(P, 'account', 'bidder');

      await step('DEV_TOOLS tắt (mặc định): /api/dev không tồn tại, trả 404 NOT_FOUND kể cả khi có token', async () => {
        const { server } = require('../src/app');
        await new Promise((res) => server.listen(0, '127.0.0.1', res));
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
          for (const [p, t] of [['/api/dev/auctions/1/end-soon', tokP], ['/api/dev/orders/1/expire-payment', tokP], ['/api/dev/auctions/1/end-soon', null]]) {
            const r = await call(url, 'POST', p, t, { seconds: 5 });
            assert.deepStrictEqual([r.status, r.success, r.error.code], [404, false, 'NOT_FOUND'], p);
          }
        } finally {
          await new Promise((res) => server.close(res));
        }
      });

      await step('DEV_TOOLS=true nhưng NODE_ENV=production: vẫn 404 (không mở /api/dev)', async () => {
        const prod = await startServer({ DEV_TOOLS: 'true', NODE_ENV: 'production' });
        try {
          const r = await call(prod.url, 'POST', '/api/dev/auctions/1/end-soon', tokP, { seconds: 5 });
          assert.deepStrictEqual([r.status, r.error.code], [404, 'NOT_FOUND']);
          assert.ok(prod.output().includes('bị bỏ qua vì NODE_ENV=production'), prod.output());
        } finally { await prod.stop(); }
      });

      const dev = await startServer({ DEV_TOOLS: 'true' });
      // Phiên kết thúc với `winner` thắng (tạo và đóng trong tiến trình test), trả { auctionId, orderId }.
      const endedOrder = async (winner) => {
        const { auctionId: aw } = await mkAuction(seller);
        await engine.joinAuction({ bidderId: winner, auctionId: aw });
        await engine.placeBid({ bidderId: winner, auctionId: aw, increment: 50_000 });
        await expire(aw);
        await closedAuction(aw);
        return { auctionId: aw, orderId: (await pool.query('SELECT id FROM orders WHERE auction_id = $1', [aw])).rows[0].id };
      };

      await step('end-soon: cần đăng nhập; kiểm tra seconds, 404, phiên đã kết thúc 409, phiên tạm dừng 409', async () => {
        const { auctionId: av } = await mkAuction(seller);
        let r = await call(dev.url, 'POST', `/api/dev/auctions/${av}/end-soon`, null, { seconds: 10 });
        assert.deepStrictEqual([r.status, r.error.code], [401, 'UNAUTHORIZED']);
        const before = new Date((await clock(av)).ends_at).getTime();
        for (const seconds of [4, 3601, 'abc', 5.5, 0]) {
          r = await call(dev.url, 'POST', `/api/dev/auctions/${av}/end-soon`, tokP, { seconds });
          assert.deepStrictEqual([r.status, r.error.code], [400, 'VALIDATION_ERROR'], `seconds=${seconds}`);
        }
        r = await call(dev.url, 'POST', '/api/dev/auctions/999999999/end-soon', tokP, {});
        assert.deepStrictEqual([r.status, r.error.code], [404, 'NOT_FOUND']);
        r = await call(dev.url, 'POST', '/api/dev/auctions/abc/end-soon', tokP, {});
        assert.deepStrictEqual([r.status, r.error.code], [400, 'VALIDATION_ERROR']);
        assert.strictEqual(new Date((await clock(av)).ends_at).getTime(), before, 'lỗi kiểm tra đầu vào không được đổi ends_at');

        const f = await flag(av, 'paused');
        r = await call(dev.url, 'POST', `/api/dev/auctions/${av}/end-soon`, tokP, { seconds: 10 });
        assert.deepStrictEqual([r.status, r.error.code], [409, 'AUCTION_PAUSED']);
        await pool.query(`UPDATE flagged_auctions SET status = 'safe' WHERE id = $1`, [f]);

        const { auctionId: ae } = await mkAuction(seller);
        await expire(ae);
        await closedAuction(ae);
        r = await call(dev.url, 'POST', `/api/dev/auctions/${ae}/end-soon`, tokP, { seconds: 10 });
        assert.deepStrictEqual([r.status, r.error.code], [409, 'AUCTION_ENDED']);
      });

      let ended;
      await step('end-soon: đặt ends_at, phát auction:update reason dev_time, scheduler đóng phiên và tạo đơn cho người dẫn đầu', async () => {
        const { auctionId: ad } = await mkAuction(seller);
        await engine.joinAuction({ bidderId: P, auctionId: ad });
        await engine.joinAuction({ bidderId: Q, auctionId: ad });
        await engine.placeBid({ bidderId: Q, auctionId: ad, increment: 50_000 });
        await engine.placeBid({ bidderId: P, auctionId: ad, increment: 50_000 }); // P dẫn đầu
        const heldQ = (await wallet(Q)).h;

        const s = ioClient(dev.url, { auth: { token: tokP }, transports: ['websocket'], reconnection: false, forceNew: true });
        sockets.push(s);
        await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
        s.emit('auction:join', String(ad));
        await sleep(300);
        const gotUpdate = waitFor(s, 'auction:update', (u) => u.auctionId === String(ad) && u.reason === 'dev_time');
        const gotEnded = waitFor(s, 'auction:ended', (e) => e.auctionId === String(ad), 30_000);

        const r = await call(dev.url, 'POST', `/api/dev/auctions/${ad}/end-soon`, tokP, { seconds: 5 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.error));
        assert.deepStrictEqual(Object.keys(r.data).sort(), ['auctionId', 'endsAt', 'remainingSeconds']);
        assert.strictEqual(r.data.auctionId, String(ad));
        assert.strictEqual(r.data.remainingSeconds, 5);
        const left = new Date(r.data.endsAt) - Date.now();
        assert.ok(left > -2000 && left < 8000, `endsAt còn ${left}ms, mong ~5000ms`);
        assert.strictEqual(new Date((await clock(ad)).ends_at).getTime(), new Date(r.data.endsAt).getTime());

        const u = await gotUpdate;
        assert.ok(u, 'không nhận được auction:update reason dev_time');
        assert.strictEqual(new Date(u.endsAt).getTime(), new Date(r.data.endsAt).getTime());
        assert.strictEqual(u.remainingSeconds, 5);
        assert.deepStrictEqual([u.status, u.paused, u.pausedAt, u.currentPrice, u.bidCount], ['active', false, null, 1_100_000, 2]);

        // Việc đóng phiên do scheduler của server con làm như thật.
        const row = await until('SELECT status, winner_id FROM auctions WHERE id = $1', [ad], (x) => x.status !== 'active');
        assert.ok(row, 'phiên không được đóng sau khi hết giờ');
        assert.deepStrictEqual([row.status, String(row.winner_id)], ['ended', String(P)]);
        assert.ok(await gotEnded, 'không nhận được auction:ended');
        const order = (await pool.query(
          'SELECT id, bidder_id, final_price::int AS fp, payment_status FROM orders WHERE auction_id = $1', [ad])).rows;
        assert.strictEqual(order.length, 1);
        assert.deepStrictEqual([String(order[0].bidder_id), order[0].fp, order[0].payment_status], [String(P), 1_100_000, 'awaiting_payment']);
        assert.strictEqual((await wallet(Q)).h, heldQ - 100_000, 'cọc của người thua phải được hoàn');
        ended = { auctionId: ad, orderId: order[0].id };
      });

      await step('expire-payment: đặt hạn về quá khứ, scheduler huỷ đơn và tịch thu cọc; gọi lại 409 PAYMENT_EXPIRED', async () => {
        const heldBefore = (await wallet(P)).h;
        let r = await call(dev.url, 'POST', `/api/dev/orders/${ended.orderId}/expire-payment`, tokP);
        assert.strictEqual(r.status, 200, JSON.stringify(r.error));
        assert.deepStrictEqual(Object.keys(r.data).sort(), ['orderId', 'paymentDeadline']);
        assert.strictEqual(r.data.orderId, String(ended.orderId));
        // paymentDeadline = now() - 1 giây của DB: so với giờ máy cho dung sai +2 giây (lệch đồng hồ máy / DB)
        assert.ok(new Date(r.data.paymentDeadline) < new Date(Date.now() + 2000), 'paymentDeadline phải ở quá khứ');
        const o = await until('SELECT payment_status FROM orders WHERE id = $1', [ended.orderId], (x) => x.payment_status === 'expired');
        assert.ok(o, 'đơn không bị scheduler đánh dấu expired');
        const dep = (await pool.query(
          'SELECT status FROM auction_deposits WHERE auction_id = $1 AND bidder_id = $2', [ended.auctionId, P])).rows[0];
        assert.strictEqual(dep.status, 'forfeited');
        // Cọc đã chuyển sang trạng thái "áp vào thanh toán" lúc đóng phiên nên không còn nằm trong wallet_held; chỉ cần
        // có giao dịch forfeit và không hoàn lại.
        const forfeits = await pool.query(`SELECT 1 FROM wallet_transactions WHERE bidder_id = $1 AND kind = 'deposit_forfeit'`, [P]);
        assert.strictEqual(forfeits.rowCount, 1);
        assert.strictEqual((await wallet(P)).h, heldBefore - 100_000, 'cọc bị tịch thu không còn nằm trong ví');
        r = await call(dev.url, 'POST', `/api/dev/orders/${ended.orderId}/expire-payment`, tokP);
        assert.deepStrictEqual([r.status, r.error.code], [409, 'PAYMENT_EXPIRED']);
      });

      await step('expire-payment: đơn đã thanh toán 409 ALREADY_PAID; không có đơn 404', async () => {
        const paid = await endedOrder(Q);
        await engine.payOrder({ bidderId: Q, orderId: paid.orderId, method: 'wallet' });
        let r = await call(dev.url, 'POST', `/api/dev/orders/${paid.orderId}/expire-payment`, tokP);
        assert.deepStrictEqual([r.status, r.error.code], [409, 'ALREADY_PAID']);
        r = await call(dev.url, 'POST', '/api/dev/orders/999999999/expire-payment', tokP);
        assert.deepStrictEqual([r.status, r.error.code], [404, 'NOT_FOUND']);
        const after = (await pool.query('SELECT payment_status, payment_deadline FROM orders WHERE id = $1', [paid.orderId])).rows[0];
        assert.strictEqual(after.payment_status, 'paid');
        assert.ok(new Date(after.payment_deadline) > new Date(), 'đơn đã trả tiền không bị đổi hạn');
      });
    } finally {
      sockets.forEach((s) => s.close());
      await Promise.all(children.map(({ child, exited }) => { child.kill(); return exited; }));
    }
  }

  console.log('Real-time giữa nhiều backend cùng một database (pg_notify kênh bidvibe_events)');
  {
    const { spawn } = require('child_process');
    const net = require('net');
    const path = require('path');
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const { io: ioClient } = require('socket.io-client');
    const tok = (id, kind, role) => jwt.sign({ sub: String(id), kind, role }, env.jwtSecret, { expiresIn: '5m' });
    const freePort = () => new Promise((resolve, reject) => {
      const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
    // Server con chạy `node src/app.js` như npm run dev của một người khác: cổng riêng, cùng DB, pool 2.
    const children = [];
    const startServer = async (name) => {
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'app.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), DB_POOL_MAX: '2', NODE_ENV: 'development' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      // Sẵn sàng khi đã lắng nghe cổng VÀ đã LISTEN kênh bidvibe_events.
      for (const end = Date.now() + 20_000; !(out.includes('đang chạy tại') && out.includes('[realtime] đang nghe')); await sleep(200)) {
        if (child.exitCode !== null) throw new Error(`server ${name} thoát sớm: ${out.slice(-300)}`);
        if (Date.now() > end) throw new Error(`server ${name} không sẵn sàng sau 20 giây. Output của server con:
${out.slice(-600)}`);
      }
      return `http://127.0.0.1:${port}`;
    };
    const sockets = [];
    const connect = (url, token) => new Promise((resolve, reject) => {
      const s = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(s);
      s.once('connect', () => resolve(s));
      s.once('connect_error', (e) => { s.close(); reject(e); });
    });
    const waitFor = (s, event, pred = () => true, ms = 8000) => new Promise((resolve) => {
      const timer = setTimeout(() => { s.off(event, h); resolve(null); }, ms);
      function h(data) { if (pred(data)) { clearTimeout(timer); s.off(event, h); resolve(data ?? true); } }
      s.on(event, h);
    });
    const rest = async (url, method, p, token, body) => {
      const r = await fetch(url + p, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await r.json();
      assert.strictEqual(r.status < 300, true, `${method} ${p}: ${r.status} ${JSON.stringify(j.error)}`);
      return j.data;
    };

    try {
      const [urlA, urlB] = [await startServer('A'), await startServer('B')];
      const S = await mkAccount('seller', 'MultiSel');
      const [P, Q] = [await mkAccount('bidder', 'MultiP'), await mkAccount('bidder', 'MultiQ')];
      for (const id of [P, Q]) await tx((c) => walletService.topUp(c, { bidderId: id, amount: 5_000_000 }));
      const { auctionId: am } = await mkAuction(S);
      await engine.joinAuction({ bidderId: P, auctionId: am });
      await engine.joinAuction({ bidderId: Q, auctionId: am });
      const sP = await connect(urlB, tok(P, 'account', 'bidder')); // P nối server B
      sP.emit('auction:join', String(am));
      await sleep(300);

      await step('đặt giá qua REST server A -> client nối server B nhận auction:update (đúng một lần)', async () => {
        const updates = [];
        sP.on('auction:update', (u) => { if (u.auctionId === String(am)) updates.push(u); });
        const got = waitFor(sP, 'auction:update', (u) => u.auctionId === String(am) && u.reason === 'bid');
        const bid = await rest(urlA, 'POST', '/api/bids', tok(P, 'account', 'bidder'), { auctionId: String(am), increment: 50_000 });
        const u = await got;
        assert.ok(u, 'server B không phát auction:update của lượt giá đặt ở server A');
        assertServerTime(u, 'auction:update qua server B'); // giờ của server B (nơi client nối), không phải server A
        assert.strictEqual(u.currentPrice, bid.currentPrice);
        await sleep(800);
        assert.strictEqual(updates.length, 1, `nhận ${updates.length} lần auction:update (mong 1)`);
        sP.off('auction:update');
      });
      await step('bị vượt giá (đặt qua server A) -> client nối server B nhận notification:new outbid có data', async () => {
        const got = waitFor(sP, 'notification:new', (n) => n.type === 'outbid');
        await rest(urlA, 'POST', '/api/bids', tok(Q, 'account', 'bidder'), { auctionId: String(am), increment: 50_000 });
        const n = await got;
        assert.ok(n, 'server B không phát notification:new');
        assert.deepStrictEqual(n.data, { auctionId: String(am) });
        assert.ok(['id', 'type', 'title', 'createdAt', 'data'].every((k) => k in n));
      });
      await step('Admin khoá tài khoản qua server A -> client nối server B nhận account:disconnected rồi bị ngắt', async () => {
        const adminId = (await pool.query(
          `INSERT INTO ops_accounts (name, email, role) VALUES ($1, $2, 'admin') RETURNING id`,
          [`${PREFIX}multi_admin`, `${RUN}multi_admin_${Math.floor(Math.random() * 1e6)}${DOMAIN}`])).rows[0].id;
        const notice = waitFor(sP, 'account:disconnected');
        const gone = new Promise((resolve) => sP.once('disconnect', resolve));
        await rest(urlA, 'PATCH', `/api/admin/accounts/${P}`, tok(adminId, 'ops', 'admin'), { status: 'suspended' });
        assert.deepStrictEqual(await notice, { code: 'ACCOUNT_SUSPENDED', message: 'Tài khoản đã bị khoá' });
        const reason = await Promise.race([gone, sleep(8000).then(() => null)]);
        assert.ok(reason, 'server B không ngắt socket của tài khoản bị khoá');
      });
    } finally {
      sockets.forEach((s) => s.close());
      // Luôn tắt server con, kể cả khi bước nào đó lỗi.
      await Promise.all(children.map((c) => new Promise((resolve) => {
        if (c.exitCode !== null || c.signalCode !== null) return resolve(); // đã thoát (kể cả bị tín hiệu): 'exit' không phát lại
        c.once('exit', resolve);
        c.kill();
      })));
    }
  }

  finished = true;
  console.log(`\nTất cả ${passed} bước đạt.`);
}

// Nếu event loop cạn trước khi main() xong (một promise treo), Node thoát với mã 0 mà không chạy cleanup:
// biến thành thất bại thay vì báo đạt giả.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) { console.error('\n✗ THẤT BẠI: test dừng giữa chừng (có promise treo), chưa chạy hết các phần.'); process.exitCode = 1; }
});

main()
  .catch((err) => { console.error('\n✗ THẤT BẠI:', err); process.exitCode = 1; })
  .finally(async () => {
    await cleanup('run').catch((e) => console.error('cleanup lỗi:', e.message));
    await cleanupOps('run').catch((e) => console.error('cleanup ops lỗi:', e.message));
    await pool.end();
  });
