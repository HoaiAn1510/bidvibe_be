// Kiểm thử end-to-end phần BE2 bằng cách gọi API thật qua HTTP trên một server chạy trong
// tiến trình (cổng ngẫu nhiên), database thật dùng chung.
//   node scripts/test_be2.js                        chạy kiểm thử
//   node scripts/test_be2.js --report docs/test-be2.md   chạy và ghi kết quả ra file Markdown
//
// An toàn với dữ liệu thật: mọi tài khoản test có email test_be2_<thời điểm>_...@example.com,
// cuối cùng chỉ xoá đúng những dòng gắn với các tài khoản đó (kể cả khi lỗi giữa chừng). Dữ liệu
// demo / của BE1 không bị đụng tới (chỉ đọc qua các API danh sách của Admin).
// Server test KHÔNG chạy scheduler, nên hai mốc thời gian được ép thủ công:
//   - đóng phiên: đặt ends_at về quá khứ rồi gọi auction_engine.closeAuction (BE1);
//   - tự giải ngân: đặt payout_deadline về quá khứ rồi gọi payout_service.releaseOverduePayouts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { server } = require('../src/app');
const { pool } = require('../src/config/db');
const engine = require('../src/services/auction_engine');
const payout = require('../src/services/payout_service');

const STAMP = Date.now();
const PREFIX = `test_be2_${STAMP}`;
const EMAIL_LIKE = 'test\\_be2\\_%@example.com';
const PASSWORD = 'matkhau123';
const reportPath = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;

let base;
const rows = [];
let section = '';
let passed = 0;

const email = (name) => `${PREFIX}_${name}@example.com`;

function summarize(json) {
  if (!json.success) return `${json.error.code}: ${json.error.message}`;
  const d = json.data || {};
  if (d.token) return `role=${d.role}, token=(che)`;
  return JSON.stringify(d, (k, v) => (k === 'token' ? '(che)' : v)).slice(0, 140);
}

// Gọi API thật, kiểm tra mã trạng thái, ghi lại một dòng cho báo cáo.
async function api(label, method, url, { token, body, raw, expect = 200, code, note } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const json = await res.json();
  const shown = url.replace(/^\/api/, '');
  assert.strictEqual(res.status, expect, `${label}: mong ${expect}, nhận ${res.status} ${JSON.stringify(json)}`);
  assert.ok('success' in json && 'data' in json && 'error' in json, `${label}: sai format phản hồi`);
  if (code) assert.strictEqual(json.error && json.error.code, code, `${label}: mong mã ${code}, nhận ${JSON.stringify(json.error)}`);
  const summary = note ? note(json) : summarize(json);
  rows.push({ section, label, method, url: `/api${shown}`, status: res.status, summary });
  passed += 1;
  console.log(`  ✓ ${String(res.status).padEnd(3)} ${method.padEnd(5)} ${shown.padEnd(46)} ${label}`);
  return json.data;
}

function record(label, summary) {
  rows.push({ section, label, method: '—', url: '—', status: '—', summary });
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const begin = (name) => { section = name; console.log(`\n${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function cleanup() {
  const acc = (await pool.query('SELECT id FROM accounts WHERE email LIKE $1', [EMAIL_LIKE])).rows.map((r) => r.id);
  const ops = (await pool.query('SELECT id FROM ops_accounts WHERE email LIKE $1', [EMAIL_LIKE])).rows.map((r) => r.id);
  if (!acc.length && !ops.length) return;
  const run = (sql) => pool.query(sql, [acc]);
  const orders = 'SELECT id FROM orders WHERE seller_id = ANY($1) OR bidder_id = ANY($1)';
  await run(`DELETE FROM disputes WHERE order_id IN (${orders})`);           // cascade dispute_timeline
  await run(`DELETE FROM shipments WHERE order_id IN (${orders})`);          // cascade shipment_events
  await run(`DELETE FROM warehouse_receipts WHERE order_id IN (${orders})`);
  await run(`DELETE FROM orders WHERE id IN (${orders})`);
  await run('DELETE FROM wallet_transactions WHERE bidder_id = ANY($1)');
  // cascade: bids, auction_deposits, flagged_auctions -> flag_evidence
  await run('DELETE FROM auctions WHERE listing_id IN (SELECT id FROM listings WHERE seller_id = ANY($1))');
  await run('DELETE FROM listings WHERE seller_id = ANY($1)');               // cascade photos, appraisals
  await run('DELETE FROM accounts WHERE id = ANY($1)');                      // cascade bidders, sellers, notifications, chat
  await pool.query('DELETE FROM ops_accounts WHERE id = ANY($1)', [ops]);
}

// Ép phiên hết giờ rồi đóng bằng hàm của BE1 (scheduler không chạy trong test).
async function endAuction(auctionId) {
  await pool.query(
    `UPDATE auctions SET ends_at = now() - interval '1 second', starts_at = LEAST(starts_at, now() - interval '1 hour')
     WHERE id = $1`,
    [auctionId],
  );
  return engine.closeAuction(auctionId);
}

async function wallet(token) {
  const res = await fetch(`${base}/api/wallet`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).data;
}

async function main() {
  await cleanup(); // dọn rác của lần chạy trước nếu bị ngắt giữa chừng
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  const T = {};

  // ------------------------------------------------------------------
  begin('1. Đăng ký, đăng nhập, tài khoản nội bộ');
  await api('Đăng ký với mật khẩu quá ngắn bị từ chối', 'POST', '/api/auth/register',
    { body: { fullName: 'X', email: email('bad'), password: '123', role: 'bidder' }, expect: 400 });
  await api('Đăng ký với email sai định dạng bị từ chối', 'POST', '/api/auth/register',
    { body: { fullName: 'X', email: 'khong-phai-email', password: PASSWORD, role: 'bidder' }, expect: 400 });
  await api('Body JSON hỏng trả INVALID_JSON', 'POST', '/api/auth/login', { raw: '{email:', expect: 400 });
  T.seller = (await api('Seller đăng ký', 'POST', '/api/auth/register', {
    body: { fullName: 'Người bán test', email: email('seller'), password: PASSWORD, role: 'seller', shopName: 'Shop test BE2' }, expect: 201,
  })).token;
  T.b1 = (await api('Bidder 1 đăng ký', 'POST', '/api/auth/register', {
    body: { fullName: 'Người mua Một', email: email('b1'), password: PASSWORD, role: 'bidder' }, expect: 201,
  })).token;
  T.b2 = (await api('Bidder 2 đăng ký', 'POST', '/api/auth/register', {
    body: { fullName: 'Người mua Hai', email: email('b2'), password: PASSWORD, role: 'bidder' }, expect: 201,
  })).token;
  await api('Đăng ký trùng email', 'POST', '/api/auth/register',
    { body: { fullName: 'X', email: email('b1'), password: PASSWORD, role: 'bidder' }, expect: 409 });
  await api('Đăng nhập sai mật khẩu', 'POST', '/api/auth/login', { body: { email: email('b1'), password: 'sai-mat-khau' }, expect: 401 });
  await api('Bidder 1 đăng nhập', 'POST', '/api/auth/login', { body: { email: email('b1'), password: PASSWORD } });

  // Admin test được tạo thẳng trong DB (tài khoản nội bộ không tự đăng ký), các ops khác tạo qua API.
  await pool.query(
    `INSERT INTO ops_accounts (name, email, role, password_hash) VALUES ('Admin test', $1, 'admin', $2)`,
    [email('admin'), await bcrypt.hash(PASSWORD, 10)],
  );
  T.admin = (await api('Admin đăng nhập ops', 'POST', '/api/auth/ops/login', { body: { email: email('admin'), password: PASSWORD } })).token;
  await api('Admin tạo tài khoản Thẩm định', 'POST', '/api/admin/ops-accounts',
    { token: T.admin, body: { name: 'Thẩm định test', email: email('appraiser'), role: 'appraiser', password: PASSWORD }, expect: 201 });
  const wh = await api('Admin tạo tài khoản Kho', 'POST', '/api/admin/ops-accounts',
    { token: T.admin, body: { name: 'Kho test', email: email('warehouse'), role: 'warehouse', password: PASSWORD }, expect: 201 });
  await api('Tạo ops trùng email', 'POST', '/api/admin/ops-accounts',
    { token: T.admin, body: { name: 'X', email: email('warehouse'), role: 'warehouse', password: PASSWORD }, expect: 409 });
  T.ap = (await api('Thẩm định đăng nhập', 'POST', '/api/auth/ops/login', { body: { email: email('appraiser'), password: PASSWORD } })).token;
  T.wh = (await api('Kho đăng nhập', 'POST', '/api/auth/ops/login', { body: { email: email('warehouse'), password: PASSWORD } })).token;
  await api('Seller gọi API Admin bị chặn', 'GET', '/api/admin/dashboard', { token: T.seller, expect: 403 });

  // ------------------------------------------------------------------
  begin('2. Seller đăng tin, Thẩm định yêu cầu bổ sung rồi duyệt');
  await api('Danh mục', 'GET', '/api/categories', { token: T.seller, note: (j) => j.data.categories.map((c) => c.code).join(', ') });
  const hint = await api('AI gợi ý giá', 'POST', '/api/ai/suggest-price',
    { token: T.seller, body: { categoryCode: 'elec', condition: 'Như mới' }, note: (j) => `basis=${j.data.basis}, gợi ý ${j.data.suggestedStartingPrice}` });
  const L1 = await api('Tạo tin (nháp)', 'POST', '/api/listings', {
    token: T.seller, expect: 201, note: (j) => `id=${j.data.id}, status=${j.data.status}`,
    body: { title: 'Máy nghe nhạc test BE2', categoryCode: 'elec', startingPrice: 1_000_000, durationHours: 24, condition: 'Như mới', aiSuggestedPrice: hint.suggestedStartingPrice },
  });
  await api('Gửi thẩm định khi chưa có ảnh', 'POST', `/api/listings/${L1.id}/submit`, { token: T.seller, expect: 400 });
  await api('Thêm ảnh (URL)', 'POST', `/api/listings/${L1.id}/photos`,
    { token: T.seller, body: { urls: ['https://picsum.photos/seed/be2a/800/600', 'https://picsum.photos/seed/be2b/800/600'] }, expect: 201, note: (j) => `${j.data.photos.length} ảnh` });
  await api('Gửi thẩm định', 'POST', `/api/listings/${L1.id}/submit`, { token: T.seller, note: (j) => `status=${j.data.status}` });
  await api('Sửa khi đang chờ thẩm định', 'PATCH', `/api/listings/${L1.id}`, { token: T.seller, body: { title: 'x' }, expect: 409 });
  await api('Hàng chờ thẩm định có tin mới', 'GET', '/api/appraisals/queue',
    { token: T.ap, note: (j) => `có tin test: ${j.data.items.some((i) => String(i.listingId) === String(L1.id))}` });
  await api('Yêu cầu bổ sung', 'POST', `/api/appraisals/${L1.id}/decision`,
    { token: T.ap, body: { decision: 'more_info', reason: 'Chụp thêm ảnh số seri' }, expect: 201, note: (j) => `listing=${j.data.listingStatus}` });
  await api('Duyệt khi tin đang chờ bổ sung', 'POST', `/api/appraisals/${L1.id}/decision`, { token: T.ap, body: { decision: 'approve' }, expect: 409 });
  await api('Seller sửa mô tả (needs_info)', 'PATCH', `/api/listings/${L1.id}`, { token: T.seller, body: { description: 'Đã bổ sung ảnh số seri' } });
  await api('Seller thêm ảnh số seri', 'POST', `/api/listings/${L1.id}/photos`, { token: T.seller, body: { url: 'https://picsum.photos/seed/be2c/800/600' }, expect: 201 });
  await api('Seller nộp lại', 'POST', `/api/listings/${L1.id}/resubmit`, { token: T.seller, note: (j) => `status=${j.data.status}` });
  const appr = await api('Thẩm định duyệt -> sinh phiên', 'POST', `/api/appraisals/${L1.id}/decision`,
    { token: T.ap, body: { decision: 'approve' }, expect: 201, note: (j) => `listing=${j.data.listingStatus}, auctionId=${j.data.auctionId}` });
  const A1 = appr.auctionId;
  await api('Lịch sử thẩm định (2 dòng, không sửa dòng cũ)', 'GET', `/api/appraisals/${L1.id}`,
    { token: T.ap, note: (j) => j.data.history.map((h) => h.decision).join(' -> ') });
  const notes = await api('Seller nhận thông báo duyệt', 'GET', '/api/notifications', { token: T.seller, note: (j) => j.data.notifications.map((n) => n.type).join(', ') });
  assert.ok(notes.notifications.some((n) => n.type === 'listing_approved'));

  // ------------------------------------------------------------------
  begin('3. Bidder nạp ví, đặt cọc, trả giá; phiên kết thúc');
  await api('Bidder 1 nạp ví', 'POST', '/api/wallet/topup', { token: T.b1, body: { amount: 10_000_000 }, expect: 201, note: (j) => `balance=${j.data.balance}` });
  await api('Bidder 2 nạp ví', 'POST', '/api/wallet/topup', { token: T.b2, body: { amount: 10_000_000 }, expect: 201, note: (j) => `balance=${j.data.balance}` });
  await api('Đặt giá khi chưa cọc', 'POST', '/api/bids', { token: T.b1, body: { auctionId: A1, amount: 1_050_000 }, expect: 403 });
  await api('Bidder 1 đặt cọc', 'POST', `/api/auctions/${A1}/join`, { token: T.b1, expect: 201, note: (j) => `cọc ${j.data.deposit}` });
  await api('Bidder 2 đặt cọc', 'POST', `/api/auctions/${A1}/join`, { token: T.b2, expect: 201, note: (j) => `cọc ${j.data.deposit}` });
  await api('Bidder 1 trả giá', 'POST', '/api/bids', { token: T.b1, body: { auctionId: A1, amount: 1_050_000 }, expect: 201 });
  await api('Bidder 2 trả giá cao hơn', 'POST', '/api/bids', { token: T.b2, body: { auctionId: A1, amount: 1_100_000 }, expect: 201 });
  await api('Bidder 1 trả giá thấp hơn mức tối thiểu', 'POST', '/api/bids', { token: T.b1, body: { auctionId: A1, amount: 1_120_000 }, expect: 400 });
  await api('Bidder 1 trả giá', 'POST', '/api/bids', { token: T.b1, body: { auctionId: A1, amount: 1_150_000 }, expect: 201 });
  const b2Before = await wallet(T.b2);
  const closed = await endAuction(A1);
  assert.ok(closed && closed.hasWinner && closed.orderId);
  record('Ép phiên hết giờ, closeAuction (BE1) chọn người thắng', `orderId=${closed.orderId}`);
  const b2After = await wallet(T.b2);
  assert.strictEqual(b2After.balance, b2Before.balance + 100_000);
  assert.strictEqual(b2After.held, b2Before.held - 100_000);
  record('Người thua được hoàn cọc về ví', `Bidder 2: held ${b2Before.held} -> ${b2After.held}, balance ${b2Before.balance} -> ${b2After.balance}`);

  // ------------------------------------------------------------------
  begin('4. Địa chỉ giao hàng của người mua');
  await api('Bidder 1 chưa có địa chỉ', 'GET', '/api/addresses', { token: T.b1, note: (j) => `${j.data.addresses.length} địa chỉ` });
  await api('Seller không dùng API địa chỉ', 'GET', '/api/addresses', { token: T.seller, expect: 403 });
  await api('Thêm địa chỉ với số điện thoại sai', 'POST', '/api/addresses',
    { token: T.b1, body: { recipientName: 'Người mua Một', phone: 'abc', addressLine: '45 Võ Văn Tần', city: 'TP.HCM' }, expect: 400, code: 'VALIDATION_ERROR' });
  await api('Thêm địa chỉ thiếu địa chỉ', 'POST', '/api/addresses',
    { token: T.b1, body: { recipientName: 'Người mua Một', phone: '0903112233', addressLine: '  ', city: 'TP.HCM' }, expect: 400, code: 'VALIDATION_ERROR' });
  const addrA = await api('Thêm địa chỉ đầu tiên (tự thành mặc định)', 'POST', '/api/addresses', {
    token: T.b1, expect: 201, note: (j) => `id=${j.data.id}, isDefault=${j.data.isDefault}`,
    body: { recipientName: 'Người mua Một', phone: '0903 112 233', addressLine: '45 Võ Văn Tần', ward: 'Phường 6', district: 'Quận 3', city: 'TP.HCM' },
  });
  assert.strictEqual(addrA.isDefault, true);
  const addrB = await api('Thêm địa chỉ thứ hai', 'POST', '/api/addresses', {
    token: T.b1, expect: 201, note: (j) => `id=${j.data.id}, isDefault=${j.data.isDefault}`,
    body: { recipientName: 'Người mua Một (cơ quan)', phone: '0903 112 234', addressLine: '12 Phố Huế', district: 'Hai Bà Trưng', city: 'Hà Nội' },
  });
  await api('Đặt địa chỉ thứ hai làm mặc định', 'POST', `/api/addresses/${addrB.id}/default`, { token: T.b1, note: (j) => `isDefault=${j.data.isDefault}` });
  const listed = await api('Danh sách sau khi đổi mặc định', 'GET', '/api/addresses',
    { token: T.b1, note: (j) => j.data.addresses.map((a) => `${a.id}${a.isDefault ? '(mặc định)' : ''}`).join(', ') });
  assert.strictEqual(listed.addresses.filter((a) => a.isDefault).length, 1);
  await api('Sửa địa chỉ (chưa đơn nào dùng, sửa tại chỗ)', 'PATCH', `/api/addresses/${addrA.id}`,
    { token: T.b1, body: { addressLine: '45A Võ Văn Tần' }, note: (j) => `id=${j.data.id}, ${j.data.addressLine}` });
  await api('Bidder 2 sửa địa chỉ của Bidder 1', 'PATCH', `/api/addresses/${addrA.id}`, { token: T.b2, body: { city: 'Huế' }, expect: 404 });
  await api('Bidder 2 xoá địa chỉ của Bidder 1', 'DELETE', `/api/addresses/${addrA.id}`, { token: T.b2, expect: 404 });
  await api('Bidder 2 đặt mặc định địa chỉ của Bidder 1', 'POST', `/api/addresses/${addrA.id}/default`, { token: T.b2, expect: 404 });

  // ------------------------------------------------------------------
  begin('5. Thanh toán, gửi kho, kho xử lý, xác nhận, giải ngân');
  const O1 = closed.orderId;
  await api('Đơn thắng của Bidder 1', 'GET', '/api/orders/mine',
    { token: T.b1, note: (j) => { const o = j.data.orders.find((x) => String(x.id) === String(O1)); return `totalDue=${o.totalDue}, amountToPay=${o.amountToPay}`; } });
  await api('Gửi kho khi chưa thanh toán', 'POST', `/api/orders/${O1}/ship-to-warehouse`, { token: T.seller, expect: 409 });
  await api('Bidder 1 thanh toán bằng ví', 'POST', `/api/orders/${O1}/pay`, { token: T.b1, body: { method: 'wallet' }, note: (j) => `paymentStatus=${j.data.paymentStatus}` });
  await api('Seller xem đơn đã bán', 'GET', '/api/orders/selling?stage=awaiting_seller_shipment',
    { token: T.seller, note: (j) => `${j.data.orders.length} đơn chờ gửi kho` });
  await api('Bidder không gọi được API của Seller', 'GET', '/api/orders/selling', { token: T.b1, expect: 403 });
  await api('Kho nhận hàng khi Seller chưa gửi', 'POST', `/api/warehouse/orders/${O1}/receive`, { token: T.wh, expect: 409 });
  await api('Seller gửi hàng về kho', 'POST', `/api/orders/${O1}/ship-to-warehouse`,
    { token: T.seller, note: (j) => `stage=${j.data.stage}, mã ${j.data.warehouse.orderCode}` });
  await api('Seller gửi lần hai', 'POST', `/api/orders/${O1}/ship-to-warehouse`, { token: T.seller, expect: 409 });
  await api('Kho xem đơn đang về', 'GET', '/api/warehouse/orders?stage=in_transit_to_warehouse',
    { token: T.wh, note: (j) => `có đơn test: ${j.data.orders.some((o) => String(o.id) === String(O1))}` });
  await api('Đóng gói trước khi nhận', 'POST', `/api/warehouse/orders/${O1}/pack`, { token: T.wh, expect: 409 });
  await api('Kho nhận hàng', 'POST', `/api/warehouse/orders/${O1}/receive`, { token: T.wh, note: (j) => `stage=${j.data.stage}` });
  await api('Kiểm hàng: khớp mô tả', 'POST', `/api/warehouse/orders/${O1}/inspect`,
    { token: T.wh, body: { result: 'match', notes: 'Đạt, tình trạng Như mới' }, note: (j) => `stage=${j.data.stage}` });
  await api('Gửi đi trước khi đóng gói', 'POST', `/api/warehouse/orders/${O1}/ship`, { token: T.wh, body: { carrier: 'GHN', trackingCode: 'X' }, expect: 409 });
  await api('Đóng gói', 'POST', `/api/warehouse/orders/${O1}/pack`, { token: T.wh, body: {}, note: (j) => `stage=${j.data.stage}` });
  await api('Gửi đi khi đơn chưa có địa chỉ', 'POST', `/api/warehouse/orders/${O1}/ship`,
    { token: T.wh, body: { carrier: 'GHN Express', trackingCode: 'GHNTEST0001' }, expect: 409, code: 'ORDER_NO_ADDRESS' });
  await api('Bidder 2 gắn địa chỉ vào đơn của Bidder 1', 'POST', `/api/orders/${O1}/shipping-address`,
    { token: T.b2, body: { addressId: Number(addrA.id) }, expect: 404 });
  await api('Seller gắn địa chỉ vào đơn', 'POST', `/api/orders/${O1}/shipping-address`,
    { token: T.seller, body: { addressId: Number(addrA.id) }, expect: 403 });
  await api('Bidder 1 chọn địa chỉ giao hàng', 'POST', `/api/orders/${O1}/shipping-address`,
    { token: T.b1, body: { addressId: Number(addrB.id) }, note: (j) => `${j.data.shippingAddress.addressLine}, ${j.data.shippingAddress.city}` });
  await api('Bidder 1 đổi sang địa chỉ khác (còn trước khi gửi)', 'POST', `/api/orders/${O1}/shipping-address`,
    { token: T.b1, body: { addressId: Number(addrA.id) }, note: (j) => `${j.data.shippingAddress.addressLine}, ${j.data.shippingAddress.city}` });
  await api('Kho thấy địa chỉ giao hàng', 'GET', '/api/warehouse/orders?stage=packed',
    { token: T.wh, note: (j) => { const o = j.data.orders.find((x) => String(x.id) === String(O1)); return `${o.shippingAddress.recipientName} · ${o.shippingAddress.phone} · ${o.shippingAddress.addressLine}, ${o.shippingAddress.city}`; } });
  await api('Gửi cho đơn vị vận chuyển', 'POST', `/api/warehouse/orders/${O1}/ship`,
    { token: T.wh, body: { carrier: 'GHN Express', trackingCode: 'GHNTEST0001' }, note: (j) => `stage=${j.data.stage}, mã ${j.data.shipment.trackingCode}` });
  await api('Đổi địa chỉ khi đơn đã gửi đi', 'POST', `/api/orders/${O1}/shipping-address`,
    { token: T.b1, body: { addressId: Number(addrB.id) }, expect: 409, code: 'ALREADY_SHIPPED' });
  await api('Bidder xác nhận khi chưa giao', 'POST', `/api/orders/${O1}/confirm-delivery`, { token: T.b1, expect: 409 });
  const dv = await api('Giao thành công', 'POST', `/api/warehouse/orders/${O1}/deliver`,
    { token: T.wh, note: (j) => `stage=${j.data.stage}, payoutDeadline=${j.data.payoutDeadline}` });
  const hours = (new Date(dv.payoutDeadline) - Date.now()) / 3600_000;
  assert.ok(hours > 71.9 && hours <= 72, `payout_deadline phải là +72 giờ, nhận ${hours}`);
  await api('Bidder 2 xác nhận đơn không phải của mình', 'POST', `/api/orders/${O1}/confirm-delivery`, { token: T.b2, expect: 404 });
  await api('Bidder 1 xác nhận đã nhận hàng', 'POST', `/api/orders/${O1}/confirm-delivery`,
    { token: T.b1, note: (j) => `stage=${j.data.stage}, payoutStatus=${j.data.payoutStatus}` });
  await api('Xác nhận lần hai', 'POST', `/api/orders/${O1}/confirm-delivery`, { token: T.b1, expect: 409 });
  await api('Theo dõi đơn (người mua)', 'GET', `/api/orders/${O1}/tracking`,
    { token: T.b1, note: (j) => `${j.data.events.map((e) => e.step).join(' -> ')}; giao tới ${j.data.shippingAddress.addressLine}` });
  const sellerView = await api('Theo dõi đơn (người bán, không thấy địa chỉ)', 'GET', `/api/orders/${O1}/tracking`,
    { token: T.seller, note: (j) => `có shippingAddress: ${'shippingAddress' in j.data}` });
  assert.ok(!('shippingAddress' in sellerView));
  // Địa chỉ đã gắn vào đơn đã gửi: sửa thì tạo bản mới, đơn cũ giữ nguyên nội dung.
  const edited = await api('Sửa địa chỉ đơn đã gửi đang dùng (tạo bản mới)', 'PATCH', `/api/addresses/${addrA.id}`,
    { token: T.b1, body: { addressLine: '99 Nguyễn Huệ' }, note: (j) => `id cũ=${addrA.id}, id mới=${j.data.id}` });
  assert.notStrictEqual(String(edited.id), String(addrA.id));
  const kept = await api('Đơn đã gửi vẫn giữ địa chỉ cũ', 'GET', `/api/orders/${O1}/tracking`,
    { token: T.b1, note: (j) => `${j.data.shippingAddress.id}: ${j.data.shippingAddress.addressLine}` });
  assert.strictEqual(kept.shippingAddress.addressLine, '45A Võ Văn Tần');
  await api('Xoá địa chỉ (xoá mềm)', 'DELETE', `/api/addresses/${edited.id}`, { token: T.b1, note: (j) => `deleted=${j.data.deleted}` });
  const remaining = await api('Danh sách sau khi xoá', 'GET', '/api/addresses',
    { token: T.b1, note: (j) => `${j.data.addresses.length} địa chỉ, mặc định ${j.data.addresses.find((a) => a.isDefault).id}` });
  assert.ok(!remaining.addresses.some((a) => String(a.id) === String(edited.id)));
  const stillThere = await api('Đơn đã gửi vẫn đọc được địa chỉ sau khi xoá', 'GET', `/api/orders/${O1}/tracking`,
    { token: T.b1, note: (j) => `${j.data.shippingAddress.addressLine}` });
  assert.ok(stillThere.shippingAddress);
  const sn = await api('Seller nhận thông báo giải ngân', 'GET', '/api/notifications', { token: T.seller, note: (j) => j.data.notifications.map((n) => n.type).join(', ') });
  assert.ok(sn.notifications.some((n) => n.type === 'payout'));

  // Bán nhanh một món cho `winner` (dùng cho các luồng phụ bên dưới).
  async function sellOne(title, winnerToken) {
    const l = await api(`Tạo tin "${title}"`, 'POST', '/api/listings',
      { token: T.seller, expect: 201, body: { title, categoryCode: 'antique', startingPrice: 1_000_000, durationHours: 24 }, note: (j) => `id=${j.data.id}` });
    await api('Thêm ảnh', 'POST', `/api/listings/${l.id}/photos`, { token: T.seller, body: { url: 'https://picsum.photos/seed/be2x/800/600' }, expect: 201 });
    await api('Gửi thẩm định', 'POST', `/api/listings/${l.id}/submit`, { token: T.seller });
    const a = await api('Duyệt', 'POST', `/api/appraisals/${l.id}/decision`, { token: T.ap, body: { decision: 'approve' }, expect: 201, note: (j) => `auctionId=${j.data.auctionId}` });
    await api('Đặt cọc', 'POST', `/api/auctions/${a.auctionId}/join`, { token: winnerToken, expect: 201 });
    await api('Trả giá', 'POST', '/api/bids', { token: winnerToken, body: { auctionId: a.auctionId, amount: 1_050_000 }, expect: 201 });
    const c = await endAuction(a.auctionId);
    record('Ép phiên hết giờ, closeAuction (BE1)', `orderId=${c.orderId}`);
    await api('Thanh toán bằng ví', 'POST', `/api/orders/${c.orderId}/pay`, { token: winnerToken, body: { method: 'wallet' } });
    await api('Seller gửi hàng về kho', 'POST', `/api/orders/${c.orderId}/ship-to-warehouse`, { token: T.seller });
    await api('Kho nhận hàng', 'POST', `/api/warehouse/orders/${c.orderId}/receive`, { token: T.wh });
    return { orderId: c.orderId, auctionId: a.auctionId };
  }
  // Đơn của Bidder 1: chọn địa chỉ mặc định rồi đi hết các bước kho.
  async function shipAndDeliver(orderId) {
    await api('Kiểm hàng: khớp', 'POST', `/api/warehouse/orders/${orderId}/inspect`, { token: T.wh, body: { result: 'match' } });
    await api('Đóng gói', 'POST', `/api/warehouse/orders/${orderId}/pack`, { token: T.wh, body: {} });
    const mine = await api('Bidder lấy địa chỉ mặc định', 'GET', '/api/addresses', { token: T.b1, note: (j) => `${j.data.addresses.length} địa chỉ` });
    const def = mine.addresses.find((a) => a.isDefault);
    await api('Bidder chọn địa chỉ giao hàng', 'POST', `/api/orders/${orderId}/shipping-address`, { token: T.b1, body: { addressId: Number(def.id) } });
    await api('Gửi đi', 'POST', `/api/warehouse/orders/${orderId}/ship`, { token: T.wh, body: { carrier: 'Viettel Post', trackingCode: `VTP${orderId}` } });
    await api('Giao thành công', 'POST', `/api/warehouse/orders/${orderId}/deliver`, { token: T.wh });
  }

  // ------------------------------------------------------------------
  begin('6. Tranh chấp do Kho mở (hàng không khớp) -> Admin hoàn tiền');
  const B = await sellOne('Bình gốm test BE2 (tranh chấp)', T.b2);
  await api('Kiểm hàng: không khớp thiếu ghi chú', 'POST', `/api/warehouse/orders/${B.orderId}/inspect`, { token: T.wh, body: { result: 'mismatch' }, expect: 400 });
  await api('Kiểm hàng: không khớp -> tự mở tranh chấp', 'POST', `/api/warehouse/orders/${B.orderId}/inspect`,
    { token: T.wh, body: { result: 'mismatch', notes: 'Miệng bình có vết nứt, mô tả ghi nguyên vẹn' }, note: (j) => `stage=${j.data.stage}, payoutStatus=${j.data.payoutStatus}` });
  await api('Không đóng gói được đơn đang tranh chấp', 'POST', `/api/warehouse/orders/${B.orderId}/pack`, { token: T.wh, body: {}, expect: 409 });
  await api('Bidder mở thêm tranh chấp khi đã có', 'POST', '/api/disputes',
    { token: T.b2, body: { orderId: Number(B.orderId), title: 'Trùng', reason: 'x' }, expect: 409 });
  const dl = await api('Admin xem tranh chấp đang mở', 'GET', '/api/admin/disputes?status=open',
    { token: T.admin, note: (j) => `${j.data.disputes.length} tranh chấp mở` });
  const dB = dl.disputes.find((d) => String(d.orderId) === String(B.orderId));
  assert.ok(dB && dB.source === 'warehouse' && dB.reporterId === null && dB.timeline.length >= 2);
  const before = await wallet(T.b2);
  await api('Admin phán quyết hoàn tiền', 'POST', `/api/admin/disputes/${dB.id}/resolve`,
    { token: T.admin, body: { resolution: 'refund', note: 'Hàng hư hỏng so với mô tả' }, note: (j) => `status=${j.data.status}, resolution=${j.data.resolution}, ký quỹ ${j.data.escrowAmount}` });
  const after = await wallet(T.b2);
  assert.strictEqual(after.balance, before.balance + dB.escrowAmount);
  const tx = await q1(
    `SELECT kind, amount::bigint AS amount, balance_after::bigint AS balance_after FROM wallet_transactions
     WHERE bidder_id = (SELECT id FROM accounts WHERE email = $1) ORDER BY id DESC LIMIT 1`, [email('b2')]);
  assert.strictEqual(tx.kind, 'refund');
  assert.strictEqual(Number(tx.balance_after), after.balance);
  record('Ví người mua được hoàn qua wallet_service.refund (BE1)', `balance ${before.balance} -> ${after.balance}; wallet_transactions: refund ${tx.amount}, balance_after ${tx.balance_after}`);
  await api('Phán quyết lần hai', 'POST', `/api/admin/disputes/${dB.id}/resolve`, { token: T.admin, body: { resolution: 'keep' }, expect: 409 });

  // ------------------------------------------------------------------
  begin('7. Tranh chấp do Bidder mở sau khi giao -> Admin giữ nguyên, giải ngân');
  const C = await sellOne('Đồng hồ test BE2 (giữ nguyên)', T.b1);
  await shipAndDeliver(C.orderId);
  await api('Bidder 2 mở tranh chấp đơn của người khác', 'POST', '/api/disputes',
    { token: T.b2, body: { orderId: Number(C.orderId), title: 'x', reason: 'x' }, expect: 404 });
  const dc = await api('Bidder mở tranh chấp', 'POST', '/api/disputes',
    { token: T.b1, body: { orderId: Number(C.orderId), title: 'Đồng hồ chạy chậm', reason: 'Chậm 5 phút mỗi ngày' }, expect: 201, note: (j) => `source=${j.data.source}, payoutStatus=${j.data.payoutStatus}` });
  await api('Xác nhận nhận hàng khi đang tranh chấp', 'POST', `/api/orders/${C.orderId}/confirm-delivery`, { token: T.b1, expect: 409 });
  await api('Admin phán quyết giữ nguyên', 'POST', `/api/admin/disputes/${dc.id}/resolve`,
    { token: T.admin, body: { resolution: 'keep' }, note: (j) => `resolution=${j.data.resolution}, payoutStatus=${j.data.payoutStatus}` });

  // ------------------------------------------------------------------
  begin('8. Tự giải ngân sau 72 giờ');
  const D = await sellOne('Radio test BE2 (tự giải ngân)', T.b1);
  await shipAndDeliver(D.orderId);
  const notYet = await payout.releaseOverduePayouts();
  assert.ok(!notYet.map(String).includes(String(D.orderId)));
  record('Chưa tới hạn thì job không giải ngân', 'đơn vẫn payout_status = pending');
  await pool.query(`UPDATE orders SET payout_deadline = now() - interval '1 minute' WHERE id = $1`, [D.orderId]);
  const released = await payout.releaseOverduePayouts();
  assert.ok(released.map(String).includes(String(D.orderId)));
  await api('Đơn đã tự giải ngân', 'GET', `/api/orders/${D.orderId}/tracking`,
    { token: T.seller, note: (j) => `stage=${j.data.stage}, payoutStatus=${j.data.payoutStatus}, deliveredConfirmedAt=${j.data.deliveredConfirmedAt}` });

  // ------------------------------------------------------------------
  begin('9. Phiên bị gắn cờ (fraud_detection của BE1) -> Admin xử lý');
  const l = await api('Tạo tin', 'POST', '/api/listings',
    { token: T.seller, expect: 201, body: { title: 'Máy ảnh test BE2 (gắn cờ)', categoryCode: 'elec', startingPrice: 1_000_000, durationHours: 24 } });
  await api('Thêm ảnh', 'POST', `/api/listings/${l.id}/photos`, { token: T.seller, body: { url: 'https://picsum.photos/seed/be2f/800/600' }, expect: 201 });
  await api('Gửi thẩm định', 'POST', `/api/listings/${l.id}/submit`, { token: T.seller });
  const E = (await api('Duyệt', 'POST', `/api/appraisals/${l.id}/decision`, { token: T.ap, body: { decision: 'approve' }, expect: 201 })).auctionId;
  await api('Bidder 1 đặt cọc', 'POST', `/api/auctions/${E}/join`, { token: T.b1, expect: 201 });
  await api('Bidder 2 đặt cọc', 'POST', `/api/auctions/${E}/join`, { token: T.b2, expect: 201 });
  for (let i = 1; i <= 6; i += 1) {
    await fetch(`${base}/api/bids`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${i % 2 ? T.b1 : T.b2}` },
      body: JSON.stringify({ auctionId: E, amount: 1_000_000 + i * 50_000 }),
    });
  }
  record('6 lượt giá xen kẽ giữa 2 tài khoản', 'kích hoạt luật "hai tài khoản đặt xen kẽ" của fraud_detection');
  let flag;
  for (let i = 0; i < 20 && !flag; i += 1) {
    await sleep(250);
    flag = await q1(`SELECT id FROM flagged_auctions WHERE auction_id = $1 ORDER BY id LIMIT 1`, [E]);
  }
  assert.ok(flag, 'fraud_detection phải tạo cờ');
  await api('Admin xem cờ đang chờ', 'GET', '/api/admin/flags?status=pending',
    { token: T.admin, note: (j) => { const f = j.data.flags.find((x) => String(x.id) === String(flag.id)); return `${f.severity} ${f.confidence}: ${f.reason}`; } });
  await api('Tạm dừng phiên', 'POST', `/api/admin/flags/${flag.id}/action`, { token: T.admin, body: { action: 'pause' }, note: (j) => `flag=${j.data.status}` });
  await api('Đặt giá khi phiên tạm dừng', 'POST', '/api/bids', { token: T.b1, body: { auctionId: E, amount: 2_000_000 }, expect: 409 });
  await api('Chuyển sang xác minh (bỏ tạm dừng)', 'POST', `/api/admin/flags/${flag.id}/action`, { token: T.admin, body: { action: 'verify' }, note: (j) => `flag=${j.data.status}` });
  await api('Chấm dứt thiếu lý do', 'POST', `/api/admin/flags/${flag.id}/action`, { token: T.admin, body: { action: 'terminate' }, expect: 400 });
  const w1 = await wallet(T.b1);
  await api('Chấm dứt phiên (cancelAuction của BE1)', 'POST', `/api/admin/flags/${flag.id}/action`,
    { token: T.admin, body: { action: 'terminate', reason: 'Nghi đẩy giá' }, note: (j) => `flag=${j.data.status}, phiên=${j.data.auction.status}` });
  const w1b = await wallet(T.b1);
  assert.strictEqual(w1b.held, w1.held - 100_000);
  record('Chấm dứt phiên hoàn cọc người tham gia', `Bidder 1 held ${w1.held} -> ${w1b.held}`);
  await api('Xử lý cờ đã đóng', 'POST', `/api/admin/flags/${flag.id}/action`, { token: T.admin, body: { action: 'safe' }, expect: 409 });

  // ------------------------------------------------------------------
  begin('10. Admin: bảng điều khiển, báo cáo, khoá tài khoản; Chatbot');
  await api('Bảng điều khiển', 'GET', '/api/admin/dashboard', { token: T.admin, note: (j) => `phiên live ${j.data.auctions.live}, tranh chấp mở ${j.data.disputes.open}, ký quỹ ${j.data.escrowHeld}` });
  await api('Báo cáo tuần', 'GET', '/api/admin/report/weekly', { token: T.admin, note: (j) => `${j.data.sales.orders} đơn, GMV ${j.data.sales.gmv}` });
  await api('Danh sách tài khoản (lọc theo từ khoá)', 'GET', `/api/admin/accounts?q=${PREFIX}`, { token: T.admin, note: (j) => `${j.data.accounts.length} tài khoản test` });
  const b2id = (await q1('SELECT id FROM accounts WHERE email = $1', [email('b2')])).id;
  await api('Khoá Bidder 2', 'PATCH', `/api/admin/accounts/${b2id}`, { token: T.admin, body: { status: 'suspended' }, note: (j) => `status=${j.data.status}` });
  await api('Token cũ của tài khoản bị khoá', 'GET', '/api/me', { token: T.b2, expect: 403 });
  await api('Mở khoá Bidder 2', 'PATCH', `/api/admin/accounts/${b2id}`, { token: T.admin, body: { status: 'active' } });
  await api('Token dùng lại được', 'GET', '/api/me', { token: T.b2 });
  await api('Khoá tài khoản Kho', 'PATCH', `/api/admin/ops-accounts/${wh.id}`, { token: T.admin, body: { status: 'suspended' }, note: (j) => `status=${j.data.status}` });
  await api('Kho bị khoá gọi API', 'GET', '/api/warehouse/orders', { token: T.wh, expect: 403 });
  const adminId = (await q1('SELECT id FROM ops_accounts WHERE email = $1', [email('admin')])).id;
  await api('Admin tự khoá chính mình', 'PATCH', `/api/admin/ops-accounts/${adminId}`, { token: T.admin, body: { status: 'suspended' }, expect: 409 });
  const chat = await api('Chatbot trả lời về đặt cọc', 'POST', '/api/chat/messages',
    { token: T.b1, body: { content: 'Đặt cọc như thế nào?' }, expect: 201, note: (j) => j.data.messages[1].content.slice(0, 80) });
  assert.ok(chat.messages[1].content.includes('10%'));
  await api('Hỏi tiếp trong cùng phiên trò chuyện', 'POST', '/api/chat/messages',
    { token: T.b1, body: { sessionId: chat.sessionId, content: 'Bao lâu thì giải ngân?' }, expect: 201, note: (j) => j.data.messages[1].content.slice(0, 80) });
  await api('Lịch sử trò chuyện', 'GET', `/api/chat/sessions/${chat.sessionId}/messages`, { token: T.b1, note: (j) => `${j.data.messages.length} tin nhắn` });
  await api('Người khác đọc lịch sử trò chuyện', 'GET', `/api/chat/sessions/${chat.sessionId}/messages`, { token: T.b2, expect: 404 });

  // ------------------------------------------------------------------
  begin('11. Kiểm tra tính nhất quán của ví');
  const bad = await pool.query(
    `SELECT b.account_id FROM bidders b JOIN accounts a ON a.id = b.account_id
     JOIN LATERAL (SELECT balance_after FROM wallet_transactions w WHERE w.bidder_id = b.account_id ORDER BY id DESC LIMIT 1) t ON true
     WHERE a.email LIKE $1 AND t.balance_after <> b.wallet_balance`,
    [EMAIL_LIKE],
  );
  assert.strictEqual(bad.rowCount, 0);
  record('Số dư ví khớp balance_after của giao dịch cuối', 'cả hai Bidder test');
}

function writeReport(ok, error) {
  const out = [
    '# Kết quả kiểm thử BE2',
    '',
    `Chạy lúc ${new Date().toISOString()} bằng \`node scripts/test_be2.js --report docs/test-be2.md\`.`,
    'Gọi API thật qua HTTP (server chạy trong tiến trình, cổng ngẫu nhiên) trên database thật dùng chung.',
    'Tài khoản test có email `test_be2_<thời điểm>_...@example.com` và được dọn sạch sau khi chạy.',
    'Server test không chạy scheduler nên hai mốc thời gian được ép: đóng phiên (đặt `ends_at` về quá khứ rồi gọi `closeAuction` của BE1) và tự giải ngân (đặt `payout_deadline` về quá khứ rồi gọi `releaseOverduePayouts`). Token trong phản hồi được che.',
    '',
    `**Kết quả: ${ok ? `ĐẠT ${passed} bước` : `LỖI sau ${passed} bước — ${error}`}**`,
  ];
  let current = null;
  for (const r of rows) {
    if (r.section !== current) {
      current = r.section;
      out.push('', `## ${current}`, '', '| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |', '|---|---|---|---|---|');
    }
    const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    out.push(`| ${cell(r.label)} | ${r.method} | \`${cell(r.url)}\` | ${r.status} | ${cell(r.summary)} |`);
  }
  fs.writeFileSync(path.resolve(reportPath), `${out.join('\n')}\n`, 'utf8');
  console.log(`\nĐã ghi báo cáo: ${reportPath}`);
}

main()
  .then(() => {
    console.log(`\nTất cả ${passed} bước đạt.`);
    if (reportPath) writeReport(true);
  })
  .catch((err) => {
    console.error('\nLỖI:', err.message);
    if (reportPath) writeReport(false, err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup lỗi:', e.message));
    server.close();
    await pool.end();
  });
