// Kiểm thử end-to-end phần BE2 bằng cách gọi API thật qua HTTP trên một server chạy trong
// tiến trình (cổng ngẫu nhiên), database thật dùng chung.
//   node scripts/test_be2.js                        chạy kiểm thử
//   node scripts/test_be2.js --report docs/test-be2.md   chạy và ghi kết quả ra file Markdown
//
// Chạy song song được (nhiều người, hoặc cùng lúc với test:be1) trên database dùng chung:
//   - mỗi lần chạy có mã riêng; email, họ tên, tên gian hàng, tiêu đề tin đều bắt đầu bằng
//     test_be2_<mã lần chạy>_ (email: test_be2_<mã>_<tên>@example.com);
//   - cuối lần chạy (kể cả khi lỗi) chỉ xoá các dòng đi ra từ tài khoản của CHÍNH lần chạy này;
//     dữ liệu bỏ sót từ lần chạy bị ngắt dọn bằng npm run test:clean (scripts/test_be2_clean.js);
//   - mọi thứ cần ghi đều tạo mới; dữ liệu demo / của BE1 / của lần chạy khác chỉ được đọc.
// Server test KHÔNG chạy scheduler, nên hai mốc thời gian được ép thủ công:
//   - đóng phiên: đặt ends_at về quá khứ rồi gọi auction_engine.closeAuction (BE1);
//   - tự giải ngân: đặt payout_deadline về quá khứ rồi gọi payout_service.releaseOverduePayouts
//     chỉ cho đơn của lần chạy này.
// Scheduler của server khác (đồng đội đang chạy npm run dev) có thể làm hộ hai việc trên trước;
// test chấp nhận cả hai trường hợp miễn là trạng thái cuối trong database đúng.
// Supabase session pooler giới hạn tổng số kết nối của cả database (15): test dùng ít kết nối để
// chạy song song với lần chạy khác / test:be1 / server của đồng đội. Đặt trước khi nạp pool.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '4';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
require('../src/services/auction_engine').limits.bidMinIntervalMs = 0; // test BE2 đặt giá liên tiếp nhanh; giới hạn tốc độ đã có test riêng trong test:be1
const { server, io } = require('../src/app');
const { pool } = require('../src/config/db');
const engine = require('../src/services/auction_engine');
const payout = require('../src/services/payout_service');
const uploadService = require('../src/services/upload_service');
const env = require('../src/config/env');
const registerSockets = require('../src/sockets');
const { io: ioClient } = require('socket.io-client');
const clean = require('./test_be2_clean');

// Kết nối Socket.io thật tới server test (không tự kết nối lại để quan sát việc bị ngắt).
const openSockets = [];
const sock = {
  open(token) {
    const s = ioClient(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    openSockets.push(s);
    return s;
  },
  connect(token) {
    return new Promise((resolve, reject) => {
      const s = sock.open(token);
      const t = setTimeout(() => reject(new Error('socket không kết nối được trong 10 giây')), 10_000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('connect_error', (e) => { clearTimeout(t); reject(new Error(`connect_error ${e.message}`)); });
    });
  },
  connectError(token) {
    return new Promise((resolve, reject) => {
      const s = sock.open(token);
      const t = setTimeout(() => reject(new Error('mong bị từ chối nhưng không có phản hồi')), 10_000);
      s.once('connect', () => { clearTimeout(t); s.close(); reject(new Error('tài khoản bị khoá vẫn kết nối được')); });
      s.once('connect_error', (e) => { clearTimeout(t); s.close(); resolve(e.message); });
    });
  },
  waitDisconnect(s) {
    return new Promise((resolve, reject) => {
      let notice = null;
      const t = setTimeout(() => reject(new Error('socket không bị ngắt trong 10 giây')), 10_000);
      s.once('account:disconnected', (n) => { notice = n; });
      s.once('disconnect', (reason) => { clearTimeout(t); resolve({ notice, reason }); });
    });
  },
};

// Mã lần chạy: thời điểm bắt đầu (base36) + 3 ký tự ngẫu nhiên; chỉ gồm chữ thường và số.
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')}`;
const RUN = `${clean.PREFIX}${RUN_ID}_`;
const PASSWORD = 'matkhau123';
const reportPath = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;

let base;
const rows = [];
let section = '';
let passed = 0;

const email = (name) => `${RUN}${name}${clean.DOMAIN}`;
const named = (text) => `${RUN}${text}`; // họ tên, tên gian hàng, tiêu đề tin

function summarize(json) {
  if (!json.success) return `${json.error.code}: ${json.error.message}`;
  const d = json.data || {};
  if (d.token) return `role=${d.role}, token=(che)`;
  return JSON.stringify(d, (k, v) => (k === 'token' ? '(che)' : v)).slice(0, 140);
}

// Gọi API thật, kiểm tra mã trạng thái, ghi lại một dòng cho báo cáo.
// form: FormData (multipart) — để fetch tự đặt Content-Type kèm boundary.
async function api(label, method, url, { token, body, raw, form, expect = 200, code, note } = {}) {
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(base + url, {
    method,
    headers: form ? auth : { 'Content-Type': 'application/json', ...auth },
    body: form ?? raw ?? (body === undefined ? undefined : JSON.stringify(body)),
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

// Chỉ dọn dữ liệu của lần chạy này (tài khoản có email test_be2_<mã lần chạy>_...).
async function cleanup() {
  const { acc, ops } = await clean.findAccounts(RUN);
  await clean.purge(acc.map((r) => r.id), ops.map((r) => r.id));
}

// Ép phiên hết giờ rồi đóng bằng hàm của BE1 (scheduler không chạy trong test). Nếu scheduler
// của server khác đang/đã đóng phiên này (closeAuction trả null), đọc kết quả từ database.
async function endAuction(auctionId) {
  await pool.query(
    `UPDATE auctions SET ends_at = now() - interval '1 second', starts_at = LEAST(starts_at, now() - interval '1 hour')
     WHERE id = $1`,
    [auctionId],
  );
  const r = await engine.closeAuction(auctionId);
  if (r) return r;
  for (let i = 0; i < 40; i += 1) {
    const a = await q1('SELECT status, winner_id FROM auctions WHERE id = $1', [auctionId]);
    if (a.status !== 'active') {
      const o = await q1('SELECT id FROM orders WHERE auction_id = $1', [auctionId]);
      return { auctionId, hasWinner: Boolean(a.winner_id), orderId: o ? o.id : null };
    }
    await sleep(250);
  }
  throw new Error(`phiên ${auctionId} không đóng được`);
}

// Danh sách có phân trang dùng chung với dữ liệu demo / lần chạy khác: tìm trang chứa phần tử
// của lần chạy này rồi trả về query string của trang đó (để bước kiểm thử gọi đúng trang).
async function pageOf(url, token, key, pred) {
  const sep = url.includes('?') ? '&' : '?';
  for (let offset = 0; offset < 5000; offset += 100) {
    const res = await fetch(`${base}${url}${sep}limit=100&offset=${offset}`, { headers: { Authorization: `Bearer ${token}` } });
    const list = (await res.json()).data[key];
    if (list.some(pred)) return `${url}${sep}limit=100&offset=${offset}`;
    if (list.length < 100) break;
  }
  throw new Error(`không tìm thấy phần tử của lần chạy này trong ${url}`);
}

// Object đã tải lên Storage trong lần chạy này; xoá đúng các object đó (kể cả khi test lỗi).
const uploadedPaths = [];
async function deleteUploaded() {
  while (uploadedPaths.length) {
    const p = uploadedPaths.pop();
    if (p) await uploadService.deleteObject(p).catch((e) => console.error(`không xoá được ảnh test ${p}:`, e.message));
  }
}

// Supabase Storage giả lập (chỉ dùng khi chưa cấu hình Storage thật): ghi lại request để kiểm header,
// trả "Bucket not found" khi bucket chưa được tạo, failNext = true để mô phỏng Storage lỗi.
function startMockStorage() {
  const http = require('http');
  const mock = { requests: [], buckets: new Set(), objects: new Map(), failNext: false };
  mock.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const isJson = (req.headers['content-type'] || '').startsWith('application/json');
      mock.requests.push({
        method: req.method, url: req.url, apikey: req.headers.apikey, authorization: req.headers.authorization,
        body: isJson ? JSON.parse(raw.toString()) : null,
      });
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!req.headers.apikey && !req.url.startsWith('/storage/v1/object/public/')) return send(401, { message: 'Thiếu apikey' });
      if (req.method === 'POST' && req.url === '/storage/v1/bucket') {
        mock.buckets.add(JSON.parse(raw.toString()).id);
        return send(200, { name: 'ok' });
      }
      const m = /^\/storage\/v1\/object\/(public\/)?([^/]+)\/(.+)$/.exec(req.url);
      if (!m) return send(404, { message: 'route không có' });
      const [, pub, bucket, key] = m;
      if (req.method === 'POST' && !pub) {
        if (mock.failNext) { mock.failNext = false; return send(500, { message: 'Lỗi giả lập' }); }
        if (!mock.buckets.has(bucket)) return send(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
        mock.objects.set(`${bucket}/${key}`, raw);
        return send(200, { Key: `${bucket}/${key}` });
      }
      if (req.method === 'GET' && pub) {
        if (!mock.objects.has(`${bucket}/${key}`)) return send(400, { message: 'Object not found' });
        res.writeHead(200);
        return res.end(mock.objects.get(`${bucket}/${key}`));
      }
      if (req.method === 'DELETE' && !pub) { mock.objects.delete(`${bucket}/${key}`); return send(200, {}); }
      return send(404, { message: 'route không có' });
    });
  });
  return new Promise((resolve) => mock.server.listen(0, () => {
    mock.url = `http://localhost:${mock.server.address().port}`;
    resolve(mock);
  }));
}

async function wallet(token) {
  const res = await fetch(`${base}/api/wallet`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).data;
}

async function main() {
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
    body: { fullName: named('Người bán'), email: email('seller'), password: PASSWORD, role: 'seller', shopName: named('Shop') }, expect: 201,
  })).token;
  T.b1 = (await api('Bidder 1 đăng ký', 'POST', '/api/auth/register', {
    body: { fullName: named('Người mua Một'), email: email('b1'), password: PASSWORD, role: 'bidder' }, expect: 201,
  })).token;
  T.b2 = (await api('Bidder 2 đăng ký', 'POST', '/api/auth/register', {
    body: { fullName: named('Người mua Hai'), email: email('b2'), password: PASSWORD, role: 'bidder' }, expect: 201,
  })).token;
  await api('Đăng ký trùng email', 'POST', '/api/auth/register',
    { body: { fullName: 'X', email: email('b1'), password: PASSWORD, role: 'bidder' }, expect: 409 });
  await api('Đăng nhập sai mật khẩu', 'POST', '/api/auth/login', { body: { email: email('b1'), password: 'sai-mat-khau' }, expect: 401 });
  await api('Bidder 1 đăng nhập', 'POST', '/api/auth/login', { body: { email: email('b1'), password: PASSWORD } });

  // Admin test được tạo thẳng trong DB (tài khoản nội bộ không tự đăng ký), các ops khác tạo qua API.
  await pool.query(
    `INSERT INTO ops_accounts (name, email, role, password_hash) VALUES ($3, $1, 'admin', $2)`,
    [email('admin'), await bcrypt.hash(PASSWORD, 10), named('Admin')],
  );
  T.admin = (await api('Admin đăng nhập ops', 'POST', '/api/auth/ops/login', { body: { email: email('admin'), password: PASSWORD } })).token;
  await api('Admin tạo tài khoản Thẩm định', 'POST', '/api/admin/ops-accounts',
    { token: T.admin, body: { name: named('Thẩm định'), email: email('appraiser'), role: 'appraiser', password: PASSWORD }, expect: 201 });
  const wh = await api('Admin tạo tài khoản Kho', 'POST', '/api/admin/ops-accounts',
    { token: T.admin, body: { name: named('Kho'), email: email('warehouse'), role: 'warehouse', password: PASSWORD }, expect: 201 });
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
    body: { title: named('Máy nghe nhạc'), categoryCode: 'elec', startingPrice: 1_000_000, durationHours: 24, condition: 'Như mới', aiSuggestedPrice: hint.suggestedStartingPrice },
  });
  await api('Gửi thẩm định khi chưa có ảnh', 'POST', `/api/listings/${L1.id}/submit`, { token: T.seller, expect: 400 });
  await api('Thêm ảnh (URL)', 'POST', `/api/listings/${L1.id}/photos`,
    { token: T.seller, body: { urls: ['https://picsum.photos/seed/be2a/800/600', 'https://picsum.photos/seed/be2b/800/600'] }, expect: 201, note: (j) => `${j.data.photos.length} ảnh` });
  await api('Gửi thẩm định', 'POST', `/api/listings/${L1.id}/submit`, { token: T.seller, note: (j) => `status=${j.data.status}` });
  await api('Sửa khi đang chờ thẩm định', 'PATCH', `/api/listings/${L1.id}`, { token: T.seller, body: { title: 'x' }, expect: 409 });
  const isL1 = (i) => String(i.listingId) === String(L1.id);
  await api('Hàng chờ thẩm định có tin mới', 'GET', await pageOf('/api/appraisals/queue', T.ap, 'items', isL1),
    { token: T.ap, note: (j) => `có tin test: ${j.data.items.some(isL1)}` });
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
  const isO1 = (o) => String(o.id) === String(O1);
  await api('Kho xem đơn đang về', 'GET', await pageOf('/api/warehouse/orders?stage=in_transit_to_warehouse', T.wh, 'orders', isO1),
    { token: T.wh, note: (j) => `có đơn test: ${j.data.orders.some(isO1)}` });
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
  await api('Kho thấy địa chỉ giao hàng', 'GET', await pageOf('/api/warehouse/orders?stage=packed', T.wh, 'orders', isO1),
    { token: T.wh, note: (j) => { const o = j.data.orders.find(isO1); return `${o.shippingAddress.recipientName} · ${o.shippingAddress.phone} · ${o.shippingAddress.addressLine}, ${o.shippingAddress.city}`; } });
  await api('Gửi cho đơn vị vận chuyển', 'POST', `/api/warehouse/orders/${O1}/ship`,
    { token: T.wh, body: { carrier: 'GHN Express', trackingCode: 'GHNTEST0001' }, note: (j) => `stage=${j.data.stage}, mã ${j.data.shipment.trackingCode}` });
  await api('Đổi địa chỉ khi đơn đã gửi đi', 'POST', `/api/orders/${O1}/shipping-address`,
    { token: T.b1, body: { addressId: Number(addrB.id) }, expect: 409, code: 'ALREADY_SHIPPED' });
  await api('Bidder xác nhận khi chưa giao', 'POST', `/api/orders/${O1}/confirm-delivery`, { token: T.b1, expect: 409 });
  const dv = await api('Giao thành công', 'POST', `/api/warehouse/orders/${O1}/deliver`,
    { token: T.wh, note: (j) => `stage=${j.data.stage}, payoutDeadline=${j.data.payoutDeadline}` });
  // payout_deadline do DB đặt (now() + 72 giờ) còn Date.now() là giờ máy chạy test: hai đồng hồ lệch nhau (DB đang nhanh hơn
  // máy khoảng 1 giây) nên đầu trên cho dung sai +2 giây, kẻo trượt chỉ vì chênh lệch đồng hồ. Đầu dưới giữ 71.9 giờ.
  const hours = (new Date(dv.payoutDeadline) - Date.now()) / 3600_000;
  assert.ok(hours > 71.9 && hours <= 72 + 2 / 3600, `payout_deadline phải là +72 giờ, nhận ${hours}`);
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
  const B = await sellOne(named('Bình gốm (tranh chấp)'), T.b2);
  await api('Kiểm hàng: không khớp thiếu ghi chú', 'POST', `/api/warehouse/orders/${B.orderId}/inspect`, { token: T.wh, body: { result: 'mismatch' }, expect: 400 });
  await api('Kiểm hàng: không khớp -> tự mở tranh chấp', 'POST', `/api/warehouse/orders/${B.orderId}/inspect`,
    { token: T.wh, body: { result: 'mismatch', notes: 'Miệng bình có vết nứt, mô tả ghi nguyên vẹn' }, note: (j) => `stage=${j.data.stage}, payoutStatus=${j.data.payoutStatus}` });
  await api('Không đóng gói được đơn đang tranh chấp', 'POST', `/api/warehouse/orders/${B.orderId}/pack`, { token: T.wh, body: {}, expect: 409 });
  await api('Bidder mở thêm tranh chấp khi đã có', 'POST', '/api/disputes',
    { token: T.b2, body: { orderId: Number(B.orderId), title: 'Trùng', reason: 'x' }, expect: 409 });
  const isB = (d) => String(d.orderId) === String(B.orderId);
  const dl = await api('Admin xem tranh chấp đang mở', 'GET', await pageOf('/api/admin/disputes?status=open', T.admin, 'disputes', isB),
    { token: T.admin, note: (j) => `có tranh chấp của đơn test: ${j.data.disputes.some(isB)}` });
  const dB = dl.disputes.find(isB);
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
  const C = await sellOne(named('Đồng hồ (giữ nguyên)'), T.b1);
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
  const D = await sellOne(named('Radio (tự giải ngân)'), T.b1);
  await shipAndDeliver(D.orderId);
  // Chỉ xét đơn của lần chạy này: không giải ngân đơn demo hay đơn của lần chạy khác.
  const notYet = await payout.releaseOverduePayouts({ orderIds: [D.orderId] });
  assert.ok(!notYet.map(String).includes(String(D.orderId)));
  record('Chưa tới hạn thì job không giải ngân', 'đơn vẫn payout_status = pending');
  await pool.query(`UPDATE orders SET payout_deadline = now() - interval '1 minute' WHERE id = $1`, [D.orderId]);
  const released = await payout.releaseOverduePayouts({ orderIds: [D.orderId] });
  // Scheduler của server khác cũng có thể giải ngân trước; điều cần kiểm là trạng thái cuối.
  const paidOut = await q1('SELECT payout_status FROM orders WHERE id = $1', [D.orderId]);
  assert.ok(released.map(String).includes(String(D.orderId)) || paidOut.payout_status === 'released');
  assert.strictEqual(paidOut.payout_status, 'released');
  await api('Đơn đã tự giải ngân', 'GET', `/api/orders/${D.orderId}/tracking`,
    { token: T.seller, note: (j) => `stage=${j.data.stage}, payoutStatus=${j.data.payoutStatus}, deliveredConfirmedAt=${j.data.deliveredConfirmedAt}` });

  // ------------------------------------------------------------------
  begin('9. Phiên bị gắn cờ (fraud_detection của BE1) -> Admin xử lý');
  const l = await api('Tạo tin', 'POST', '/api/listings',
    { token: T.seller, expect: 201, body: { title: named('Máy ảnh (gắn cờ)'), categoryCode: 'elec', startingPrice: 1_000_000, durationHours: 24 } });
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
  const isFlag = (x) => String(x.id) === String(flag.id);
  await api('Admin xem cờ đang chờ', 'GET', await pageOf('/api/admin/flags?status=pending', T.admin, 'flags', isFlag),
    { token: T.admin, note: (j) => { const f = j.data.flags.find(isFlag); return `${f.severity} ${f.confidence}: ${f.reason}`; } });
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
  await api('Danh sách tài khoản (lọc theo từ khoá)', 'GET', `/api/admin/accounts?q=${RUN_ID}`, { token: T.admin, note: (j) => `${j.data.accounts.length} tài khoản test` });
  const b2id = (await q1('SELECT id FROM accounts WHERE email = $1', [email('b2')])).id;
  const s1 = await sock.connect(T.b2);
  record('Bidder 2 kết nối Socket.io', `connected=${s1.connected}`);
  const b2Gone = sock.waitDisconnect(s1);
  await api('Khoá Bidder 2', 'PATCH', `/api/admin/accounts/${b2id}`, { token: T.admin, body: { status: 'suspended' }, note: (j) => `status=${j.data.status}` });
  const g1 = await b2Gone;
  assert.strictEqual(g1.notice && g1.notice.code, 'ACCOUNT_SUSPENDED');
  assert.strictEqual(g1.notice.message, 'Tài khoản đã bị khoá');
  record('Socket của Bidder 2 bị ngắt ngay khi khoá', `account:disconnected ${JSON.stringify(g1.notice)}, disconnect "${g1.reason}"`);
  assert.strictEqual(await sock.connectError(T.b2), 'ACCOUNT_SUSPENDED');
  record('Bidder 2 bị khoá không kết nối lại được', 'connect_error ACCOUNT_SUSPENDED');
  await api('Token cũ của tài khoản bị khoá', 'GET', '/api/me', { token: T.b2, expect: 403 });
  await api('Mở khoá Bidder 2', 'PATCH', `/api/admin/accounts/${b2id}`, { token: T.admin, body: { status: 'active' } });
  await api('Token dùng lại được', 'GET', '/api/me', { token: T.b2 });
  const s2 = await sock.connect(T.b2);
  record('Mở khoá thì Bidder 2 kết nối lại được', `connected=${s2.connected}`);
  s2.close();

  const sw = await sock.connect(T.wh);
  record('Tài khoản Kho kết nối Socket.io', `connected=${sw.connected}`);
  const whGone = sock.waitDisconnect(sw);
  await api('Khoá tài khoản Kho', 'PATCH', `/api/admin/ops-accounts/${wh.id}`, { token: T.admin, body: { status: 'suspended' }, note: (j) => `status=${j.data.status}` });
  const g2 = await whGone;
  assert.strictEqual(g2.notice && g2.notice.code, 'ACCOUNT_SUSPENDED');
  record('Socket của tài khoản Kho bị ngắt ngay khi khoá', `account:disconnected ${JSON.stringify(g2.notice)}`);
  assert.strictEqual(await sock.connectError(T.wh), 'ACCOUNT_SUSPENDED');
  record('Tài khoản Kho bị khoá không kết nối lại được', 'connect_error ACCOUNT_SUSPENDED');
  await api('Kho bị khoá gọi API', 'GET', '/api/warehouse/orders', { token: T.wh, expect: 403 });
  await api('Mở khoá tài khoản Kho', 'PATCH', `/api/admin/ops-accounts/${wh.id}`, { token: T.admin, body: { status: 'active' } });
  const sw2 = await sock.connect(T.wh);
  record('Mở khoá thì tài khoản Kho kết nối lại được', `connected=${sw2.connected}`);
  sw2.close();

  // disconnectAccount lỗi: việc khoá đã lưu nên API vẫn phải trả 200.
  const realDisconnect = registerSockets.disconnectAccount;
  registerSockets.disconnectAccount = async () => { throw new Error('mô phỏng lỗi ngắt socket'); };
  const origErr = console.error;
  console.error = () => {};
  try {
    await api('Khoá Bidder 2 khi ngắt socket bị lỗi vẫn thành công', 'PATCH', `/api/admin/accounts/${b2id}`,
      { token: T.admin, body: { status: 'suspended' }, note: (j) => `status=${j.data.status}` });
  } finally {
    registerSockets.disconnectAccount = realDisconnect;
    console.error = origErr;
  }
  await api('Mở khoá lại Bidder 2', 'PATCH', `/api/admin/accounts/${b2id}`, { token: T.admin, body: { status: 'active' } });
  await api('Khoá lại tài khoản Kho', 'PATCH', `/api/admin/ops-accounts/${wh.id}`, { token: T.admin, body: { status: 'suspended' } });
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
  begin('11. Dữ liệu điều hướng (data) của thông báo');
  const sellerNotes = await api('Thông báo người bán có data', 'GET', '/api/notifications?limit=100',
    { token: T.seller, note: (j) => { const n = j.data.notifications.find((x) => x.type === 'listing_approved'); return `listing_approved data=${JSON.stringify(n.data)}`; } });
  const approved = sellerNotes.notifications.find((x) => x.type === 'listing_approved' && x.data && x.data.listingId === String(L1.id));
  assert.ok(approved, 'listing_approved phải có data.listingId');
  assert.strictEqual(approved.data.auctionId, String(A1));
  const needInfo = sellerNotes.notifications.find((x) => x.type === 'listing_needs_info');
  assert.deepStrictEqual(needInfo.data, { listingId: String(L1.id) });
  const bn = await api('Thông báo người mua về đơn có data', 'GET', '/api/notifications?limit=100',
    { token: T.b1, note: (j) => { const n = j.data.notifications.find((x) => x.type === 'order'); return `order data=${JSON.stringify(n.data)}`; } });
  const shipped = bn.notifications.find((x) => x.type === 'order' && x.data && x.data.orderId === String(O1));
  assert.ok(shipped && shipped.data.auctionId === String(A1), 'thông báo order phải có orderId + auctionId');
  const b2n = await api('Thông báo tranh chấp có disputeId', 'GET', '/api/notifications?limit=100',
    { token: T.b2, note: (j) => { const n = j.data.notifications.find((x) => x.type === 'refund' && x.data); return `refund data=${JSON.stringify(n.data)}`; } });
  const refundNote = b2n.notifications.find((x) => x.type === 'refund' && x.data && x.data.disputeId === String(dB.id));
  assert.ok(refundNote && refundNote.data.orderId === String(B.orderId), 'refund tranh chấp phải có orderId + disputeId');

  // Gọi theo chữ ký cũ (như BE1 đang gọi) và thông báo cũ trước migration 008: data null, không lỗi.
  const { createNotification, emitNotification, notify } = require('../src/services/notification_service');
  const b1id = (await q1('SELECT id FROM accounts WHERE email = $1', [email('b1')])).id;
  const legacy = await createNotification(pool, { accountId: b1id, type: 'outbid', title: 'Kiểu gọi BE1, không có data' });
  assert.strictEqual(legacy.data, null);
  await pool.query(`INSERT INTO notifications (account_id, type, title) VALUES ($1, 'warn', 'Thông báo cũ trước migration 008')`, [b1id]);
  const plainNotes = await api('Thông báo không có data trả data null', 'GET', '/api/notifications?limit=3',
    { token: T.b1, note: (j) => j.data.notifications.map((x) => `${x.type}:${JSON.stringify(x.data)}`).join(', ') });
  assert.ok(plainNotes.notifications.slice(0, 2).every((x) => x.data === null));
  const cleaned = await createNotification(pool, { accountId: b1id, type: 'info', title: 'data rỗng', data: { orderId: null, auctionId: '' } });
  assert.strictEqual(cleaned.data, null);
  record('createNotification bỏ khoá rỗng; không còn khoá nào thì lưu NULL', 'data { orderId: null, auctionId: "" } -> null');

  // Socket.io: notification:new gửi kèm data (có hoặc null).
  const s3 = await sock.connect(T.b1);
  const nextNote = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('không nhận được notification:new')), 10_000);
    s3.once('notification:new', (n) => { clearTimeout(t); resolve(n); });
  });
  let wait = nextNote();
  await notify(pool, b1id, 'order', 'Thử socket có data', { orderId: O1, auctionId: A1 });
  const ev1 = await wait;
  assert.deepStrictEqual(ev1.data, { orderId: String(O1), auctionId: String(A1) });
  record('Socket notification:new có data', JSON.stringify(ev1));
  wait = nextNote();
  emitNotification(await createNotification(pool, { accountId: b1id, type: 'outbid', title: 'Thử socket kiểu BE1' }));
  const ev2 = await wait;
  assert.strictEqual(ev2.data, null);
  assert.ok(['id', 'type', 'title', 'createdAt', 'data'].every((k) => k in ev2));
  record('Socket notification:new kiểu gọi BE1: data null, các trường cũ giữ nguyên', JSON.stringify(ev2));
  s3.close();

  // ------------------------------------------------------------------
  begin('12. Tải ảnh từ điện thoại (Supabase Storage)');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  const formOf = (files, field = 'files') => {
    const f = new FormData();
    for (const [buf, name, type] of files) f.append(field, new Blob([buf], { type }), name);
    return f;
  };
  const png = () => [PNG, 'anh.png', 'image/png'];
  await api('Tải ảnh không có token', 'POST', '/api/uploads/images', { form: formOf([png()]), expect: 401 });
  await api('Tài khoản nội bộ tải ảnh bị chặn', 'POST', '/api/uploads/images', { token: T.admin, form: formOf([png()]), expect: 403 });

  const realStorage = uploadService.isConfigured();
  const savedEnv = { url: env.supabaseUrl, key: env.supabaseServiceKey, bucket: env.storageBucket };
  let mock = null;
  if (!realStorage) {
    await api('Chưa cấu hình Storage thì trả 503', 'POST', '/api/uploads/images',
      { token: T.seller, form: formOf([png()]), expect: 503, code: 'UPLOAD_NOT_CONFIGURED' });
    record('Tải lên Supabase Storage thật: bỏ qua (chưa cấu hình Storage)', 'các bước dưới chạy với Storage giả lập trong tiến trình');
    mock = await startMockStorage();
    Object.assign(env, { supabaseUrl: mock.url, supabaseServiceKey: 'sb_secret_gia_lap', storageBucket: `${RUN}bucket`.replace(/_/g, '-') });
  }
  try {
    await api('File không phải ảnh (Content-Type nói là PNG)', 'POST', '/api/uploads/images',
      { token: T.seller, form: formOf([[Buffer.from('xin chao, day khong phai anh'), 'gia.png', 'image/png']]), expect: 400, code: 'INVALID_FILE_TYPE' });
    await api('Ảnh GIF bị từ chối', 'POST', '/api/uploads/images',
      { token: T.seller, form: formOf([png(), [Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00'), 'a.gif', 'image/gif']]), expect: 400, code: 'INVALID_FILE_TYPE' });
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    PNG.copy(big);
    await api('Ảnh quá 5 MB', 'POST', '/api/uploads/images', { token: T.seller, form: formOf([[big, 'to.png', 'image/png']]), expect: 413, code: 'FILE_TOO_LARGE' });
    await api('Quá 8 ảnh một lần', 'POST', '/api/uploads/images',
      { token: T.seller, form: formOf(Array.from({ length: 9 }, png)), expect: 400, code: 'TOO_MANY_FILES' });
    await api('Không có file', 'POST', '/api/uploads/images', { token: T.seller, form: new FormData(), expect: 400, code: 'VALIDATION_ERROR' });
    await api('Sai tên trường (file thay vì files)', 'POST', '/api/uploads/images',
      { token: T.seller, form: formOf([png()], 'file'), expect: 400, code: 'VALIDATION_ERROR' });
    await api('purpose không hợp lệ', 'POST', '/api/uploads/images?purpose=banner',
      { token: T.seller, form: formOf([png()]), expect: 400, code: 'VALIDATION_ERROR' });

    const up = await api('Seller tải 2 ảnh (PNG, JPEG)', 'POST', '/api/uploads/images', {
      token: T.seller, form: formOf([png(), [JPG, 'chup.jpg', 'image/jpeg']]), expect: 201,
      note: (j) => j.data.urls.map((u) => u.replace(/^.*\/object\/public\//, '…/public/')).join(', '),
    });
    up.urls.forEach((u) => { const p = uploadService.pathFromPublicUrl(u); if (p) uploadedPaths.push(p); });
    assert.strictEqual(up.urls.length, 2);
    assert.ok(up.urls[0].endsWith('.png') && up.urls[1].endsWith('.jpg'), 'URL phải theo đúng thứ tự file');
    const sellerId = (await q1('SELECT id FROM accounts WHERE email = $1', [email('seller')])).id;
    assert.ok(up.urls.every((u) => u.startsWith(`${env.supabaseUrl}/storage/v1/object/public/${env.storageBucket}/listing/${sellerId}/`)));
    for (const u of up.urls) {
      const r = await fetch(u);
      assert.strictEqual(r.status, 200, `GET ${u} phải 200`);
    }
    record('GET URL public của ảnh vừa tải', `200 cho cả ${up.urls.length} ảnh${realStorage ? '' : ' (Storage giả lập)'}`);
    const av = await api('Bidder tải ảnh đại diện (purpose=avatar)', 'POST', '/api/uploads/images?purpose=avatar',
      { token: T.b1, form: formOf([png()]), expect: 201, note: (j) => j.data.urls[0].replace(/^.*\/object\/public\//, '…/public/') });
    av.urls.forEach((u) => uploadedPaths.push(uploadService.pathFromPublicUrl(u)));
    assert.ok(av.urls[0].includes('/avatar/'));
    T.avatarUrl = av.urls[0];
    T.uploaded = up.urls;

    if (mock) {
      const puts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/storage/v1/object/'));
      assert.ok(puts.every((r) => r.apikey === 'sb_secret_gia_lap' && !r.authorization), 'key sb_secret_ chỉ đi qua header apikey');
      const creates = mock.requests.filter((r) => r.url === '/storage/v1/bucket');
      assert.strictEqual(creates.length, 1, 'bucket chưa có thì tạo đúng một lần');
      assert.deepStrictEqual(creates[0].body, {
        id: env.storageBucket, name: env.storageBucket, public: true, file_size_limit: 5 * 1024 * 1024,
        allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
      });
      record('Gọi Storage: header và tự tạo bucket', 'sb_secret_: chỉ apikey; bucket chưa có -> tạo 1 lần (public, 5 MB, 3 loại ảnh) rồi tải lại');
      env.supabaseServiceKey = 'eyJgia.lap.jwt';
      const jwtUp = await api('Key dạng JWT (service_role)', 'POST', '/api/uploads/images', { token: T.seller, form: formOf([png()]), expect: 201 });
      jwtUp.urls.forEach((u) => uploadedPaths.push(uploadService.pathFromPublicUrl(u)));
      const last = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/storage/v1/object/')).pop();
      assert.ok(last.apikey === 'eyJgia.lap.jwt' && last.authorization === 'Bearer eyJgia.lap.jwt');
      record('Key JWT gửi cả apikey và Authorization: Bearer', 'đúng');
      mock.failNext = true;
      await api('Storage trả lỗi thì 502 UPLOAD_FAILED', 'POST', '/api/uploads/images',
        { token: T.seller, form: formOf([png()]), expect: 502, code: 'UPLOAD_FAILED' });
    }
  } finally {
    // Xoá đúng các object do lần chạy này tải lên (cả khi lỗi giữa chừng: xem cuối main()).
    await deleteUploaded();
    if (mock) {
      Object.assign(env, { supabaseUrl: savedEnv.url, supabaseServiceKey: savedEnv.key, storageBucket: savedEnv.bucket });
      await new Promise((r) => mock.server.close(r));
    }
  }
  record('Xoá các ảnh test vừa tải lên Storage', realStorage ? 'đã xoá đúng các object của lần chạy' : 'Storage giả lập: đã xoá');

  // ------------------------------------------------------------------
  begin('13. Hồ sơ, đổi mật khẩu, đọc hết thông báo, xoá ảnh tin đăng');
  const meSeller = await api('GET /me của Seller có storeName', 'GET', '/api/me', { token: T.seller, note: (j) => `storeName=${j.data.storeName}` });
  assert.strictEqual(meSeller.storeName, named('Shop'));
  const meB1 = await api('GET /me của Bidder không có storeName', 'GET', '/api/me', { token: T.b1, note: (j) => `storeName có: ${'storeName' in j.data}` });
  assert.ok(!('storeName' in meB1));
  const edited2 = await api('Seller sửa họ tên, số điện thoại, tên gian hàng', 'PATCH', '/api/me', {
    token: T.seller, body: { fullName: named('Người bán (đã sửa)'), phone: '0903 222 333', shopName: named('Shop mới') },
    note: (j) => `fullName=${j.data.fullName}, phone=${j.data.phone}, storeName=${j.data.storeName}`,
  });
  assert.deepStrictEqual([edited2.fullName, edited2.phone, edited2.storeName], [named('Người bán (đã sửa)'), '0903 222 333', named('Shop mới')]);
  assert.deepStrictEqual(Object.keys(edited2).sort(), Object.keys(meSeller).sort(), 'PATCH /me trả cùng dạng GET /me');
  const withAvatar = await api('Bidder đặt ảnh đại diện bằng URL vừa tải', 'PATCH', '/api/me',
    { token: T.b1, body: { avatarUrl: T.avatarUrl }, note: (j) => `avatarUrl ${j.data.avatarUrl ? 'đã đặt' : 'trống'}` });
  assert.strictEqual(withAvatar.avatarUrl, T.avatarUrl);
  const noAvatar = await api('Bidder xoá ảnh đại diện (null)', 'PATCH', '/api/me', { token: T.b1, body: { avatarUrl: null } });
  assert.strictEqual(noAvatar.avatarUrl, null);
  await api('Số điện thoại sai', 'PATCH', '/api/me', { token: T.b1, body: { phone: 'abc' }, expect: 400, code: 'VALIDATION_ERROR' });
  await api('avatarUrl không phải URL', 'PATCH', '/api/me', { token: T.b1, body: { avatarUrl: 'khong-phai-url' }, expect: 400, code: 'VALIDATION_ERROR' });
  await api('Bidder gửi shopName', 'PATCH', '/api/me', { token: T.b1, body: { shopName: 'X' }, expect: 400, code: 'VALIDATION_ERROR' });
  await api('Không có trường nào', 'PATCH', '/api/me', { token: T.b1, body: {}, expect: 400, code: 'VALIDATION_ERROR' });
  await api('Tài khoản nội bộ sửa hồ sơ', 'PATCH', '/api/me', { token: T.admin, body: { fullName: 'X' }, expect: 403 });

  await api('Đổi mật khẩu: sai mật khẩu hiện tại', 'POST', '/api/me/password',
    { token: T.seller, body: { currentPassword: 'sai-mat-khau', newPassword: 'matkhaumoi1' }, expect: 400, code: 'WRONG_PASSWORD' });
  await api('Đổi mật khẩu: mật khẩu mới quá ngắn', 'POST', '/api/me/password',
    { token: T.seller, body: { currentPassword: PASSWORD, newPassword: '123' }, expect: 400, code: 'VALIDATION_ERROR' });
  await api('Seller đổi mật khẩu', 'POST', '/api/me/password', { token: T.seller, body: { currentPassword: PASSWORD, newPassword: 'matkhaumoi1' } });
  await api('Đăng nhập bằng mật khẩu cũ', 'POST', '/api/auth/login', { body: { email: email('seller'), password: PASSWORD }, expect: 401 });
  await api('Đăng nhập bằng mật khẩu mới', 'POST', '/api/auth/login', { body: { email: email('seller'), password: 'matkhaumoi1' } });
  await api('Tài khoản nội bộ đổi mật khẩu', 'POST', '/api/me/password', { token: T.ap, body: { currentPassword: PASSWORD, newPassword: 'matkhaumoi1' } });
  await api('Thẩm định đăng nhập bằng mật khẩu mới', 'POST', '/api/auth/ops/login', { body: { email: email('appraiser'), password: 'matkhaumoi1' } });

  const unread = await q1('SELECT count(*)::int AS n FROM notifications n JOIN accounts a ON a.id = n.account_id WHERE a.email = $1 AND NOT n.is_read', [email('b1')]);
  assert.ok(unread.n > 0, 'Bidder 1 phải có thông báo chưa đọc');
  const ra = await api('Đánh dấu đã đọc tất cả', 'POST', '/api/notifications/read-all', { token: T.b1, note: (j) => `updated=${j.data.updated}` });
  assert.strictEqual(ra.updated, unread.n);
  const allRead = await api('Mọi thông báo đã đọc', 'GET', '/api/notifications?limit=100',
    { token: T.b1, note: (j) => `${j.data.notifications.filter((n) => !n.isRead).length} chưa đọc` });
  assert.ok(allRead.notifications.every((n) => n.isRead));
  const ra2 = await api('Gọi lại khi không còn thông báo chưa đọc', 'POST', '/api/notifications/read-all', { token: T.b1, note: (j) => `updated=${j.data.updated}` });
  assert.strictEqual(ra2.updated, 0);
  await api('Tài khoản nội bộ gọi read-all', 'POST', '/api/notifications/read-all', { token: T.admin, expect: 403 });

  const L2 = await api('Tạo tin nháp để thử xoá ảnh', 'POST', '/api/listings',
    { token: T.seller, expect: 201, body: { title: named('Đèn bàn (xoá ảnh)'), categoryCode: 'antique', startingPrice: 1_000_000, durationHours: 24 } });
  const withPhotos = await api('Thêm 3 ảnh', 'POST', `/api/listings/${L2.id}/photos`, {
    token: T.seller, expect: 201, body: { urls: [...T.uploaded, 'https://picsum.photos/seed/be2d/800/600'] },
    note: (j) => `photos[].id: ${j.data.photos.map((p) => `${JSON.stringify(p.id)}`).join(', ')}`,
  });
  assert.ok(withPhotos.photos.every((p) => typeof p.id === 'string'), 'photos[].id phải là chuỗi');
  const [p1, p2, p3] = withPhotos.photos;
  const left = await api('Xoá ảnh thứ hai', 'DELETE', `/api/listings/${L2.id}/photos/${p2.id}`,
    { token: T.seller, note: (j) => `còn ${j.data.photos.map((p) => p.id).join(', ')}` });
  assert.deepStrictEqual(left.photos.map((p) => p.id), [p1.id, p3.id]);
  await api('Xoá lại ảnh đã xoá', 'DELETE', `/api/listings/${L2.id}/photos/${p2.id}`, { token: T.seller, expect: 404 });
  const otherPhoto = await q1('SELECT id FROM listing_photos WHERE listing_id = $1 LIMIT 1', [L1.id]);
  await api('Xoá ảnh của tin khác qua đường dẫn tin này', 'DELETE', `/api/listings/${L2.id}/photos/${otherPhoto.id}`, { token: T.seller, expect: 404 });
  await api('Bidder xoá ảnh tin đăng', 'DELETE', `/api/listings/${L2.id}/photos/${p1.id}`, { token: T.b1, expect: 403 });
  await api('photoId không hợp lệ', 'DELETE', `/api/listings/${L2.id}/photos/abc`, { token: T.seller, expect: 400 });
  await api('Gửi thẩm định', 'POST', `/api/listings/${L2.id}/submit`, { token: T.seller });
  await api('Xoá ảnh khi tin đang chờ thẩm định', 'DELETE', `/api/listings/${L2.id}/photos/${p1.id}`,
    { token: T.seller, expect: 409, code: 'INVALID_STATE' });

  // ------------------------------------------------------------------
  begin('14. Kiểm tra tính nhất quán của ví');
  const ledger = await pool.query(
    `SELECT b.account_id, t.balance_after = b.wallet_balance AS ok FROM bidders b JOIN accounts a ON a.id = b.account_id
     JOIN LATERAL (SELECT balance_after FROM wallet_transactions w WHERE w.bidder_id = b.account_id ORDER BY id DESC LIMIT 1) t ON true
     WHERE a.email LIKE $1`,
    [`${clean.like(RUN)}%`],
  );
  assert.strictEqual(ledger.rowCount, 2, 'phải kiểm đúng 2 Bidder của lần chạy này');
  assert.ok(ledger.rows.every((r) => r.ok));
  record('Số dư ví khớp balance_after của giao dịch cuối', 'cả hai Bidder test');

  // ------------------------------------------------------------------
  begin('15. Kết nối database bị rớt không làm sập tiến trình');
  assert.ok(pool.listenerCount('error') > 0, 'pool phải có listener cho sự kiện error');
  let exited = false;
  const onExit = () => { exited = true; };
  process.once('exit', onExit);
  const origError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const fake = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    pool.emit('error', fake, {}); // không có listener thì EventEmitter ném lỗi ra ngoài
  } finally {
    console.error = origError;
  }
  assert.ok(logged.some((l) => l.includes('ECONNRESET')), 'lỗi phải được ghi log');
  assert.ok(!logged.some((l) => /postgres(ql)?:\/\//.test(l)), 'log không được chứa chuỗi kết nối');
  const alive = await q1('SELECT 1 AS ok');
  process.removeListener('exit', onExit);
  assert.ok(!exited && alive.ok === 1);
  record('Mô phỏng pool.emit(\'error\', ECONNRESET)', `ghi log: "${logged[0]}"; tiến trình còn sống, truy vấn sau đó vẫn chạy`);
  await api('API vẫn trả lời sau lỗi kết nối', 'GET', '/api/me', { token: T.b1, note: (j) => `role=${j.data.role}` });
}

function writeReport(ok, error) {
  const out = [
    '# Kết quả kiểm thử BE2',
    '',
    `> Cập nhật: ${new Date().toISOString().slice(0, 10)}. File này được sinh tự động, không sửa tay.`,
    '',
    `Chạy lúc ${new Date().toISOString()} bằng \`node scripts/test_be2.js --report docs/test-be2.md\`.`,
    'Gọi API thật qua HTTP (server chạy trong tiến trình, cổng ngẫu nhiên) trên database thật dùng chung.',
    '',
    '**Mã lần chạy và dọn dữ liệu.** Mỗi lần chạy sinh một mã riêng (thời điểm bắt đầu dạng base36 + 3 ký tự ngẫu nhiên). Email có dạng `test_be2_<mã lần chạy>_<tên>@example.com`; họ tên, tên gian hàng, tiêu đề tin cũng bắt đầu bằng `test_be2_<mã lần chạy>_`. Cuối lần chạy (kể cả khi lỗi) chỉ xoá các dòng đi ra từ tài khoản của chính lần đó, nên hai `test:be2`, hoặc `test:be2` cùng `test:be1`, chạy song song được. Mọi dữ liệu cần ghi đều tạo mới; dữ liệu demo chỉ được đọc. Dữ liệu bỏ sót do lần chạy bị ngắt: `npm run test:clean` (xem trước bằng `npm run test:clean -- --dry-run`), chỉ xoá tài khoản `test_be2_` của lần chạy bắt đầu hơn 1 giờ trước.',
    '',
    'Server test không chạy scheduler nên hai mốc thời gian được ép: đóng phiên (đặt `ends_at` về quá khứ rồi gọi `closeAuction` của BE1) và tự giải ngân (đặt `payout_deadline` về quá khứ rồi gọi `releaseOverduePayouts` chỉ cho đơn của lần chạy). Token trong phản hồi được che.',
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
    await deleteUploaded();
    await cleanup().catch((e) => console.error('cleanup lỗi:', e.message));
    openSockets.forEach((s) => s.close());
    io.close();
    server.close();
    await pool.end();
  });
