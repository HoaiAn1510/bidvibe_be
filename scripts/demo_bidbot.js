// Giả lập vài người mua demo lần lượt trả giá một phiên, để màn hình app thấy giá nhảy
// theo thời gian thực (Socket.io auction:update). Đi qua API thật của server đang chạy
// (đăng nhập, đặt cọc, đặt giá) — không ghi thẳng vào bảng.
//
//   npm run dev                                         (một terminal khác)
//   npm run demo:bidbot -- --auction 13 [--interval 5] [--max 10] [--base http://localhost:5000]
//
// - Chỉ dùng 3 tài khoản người mua demo phụ do seed_demo.js tạo (mật khẩu demo 123456);
//   minhanh@gmail.com để dành cho người demo trên app.
// - Tự đặt cọc nếu chưa cọc. Chỉ trả giá khi số dư còn đủ trả đơn nếu thắng
//   (giá + phí 5% + vận chuyển - cọc), nên không bao giờ dùng quá số dư ví.
// - Dừng khi đủ --max lượt, phiên hết giờ / bị huỷ, không bot nào đủ tiền, hoặc Ctrl+C.
// - Từ chối chạy khi NODE_ENV=production.

const DEMO_BIDDERS = ['viet.tran@gmail.com', 'chau.le@outlook.com', 'hung.pham@gmail.com'];
const DEMO_PASSWORD = '123456';
const FEE_RATE = 0.05; // khớp auction_engine.js
const SHIPPING_FEE = 40_000;

const fmt = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Số tiền phải trả thêm nếu thắng ở giá `price` (đã trừ cọc) — cùng công thức với đơn hàng.
const dueIfWin = (price, deposit) => price + Math.round((price * FEE_RATE) / 1000) * 1000 + SHIPPING_FEE - deposit;

function parseArgs(argv) {
  const out = { interval: 5, max: 10, base: `http://localhost:${process.env.PORT || 5000}` };
  for (let i = 0; i < argv.length; i += 1) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === '--auction') { out.auction = v; i += 1; } else if (k === '--interval') { out.interval = Number(v); i += 1; } else if (k === '--max') { out.max = Number(v); i += 1; } else if (k === '--base') { out.base = v; i += 1; } else throw new Error(`Tham số không hợp lệ: ${k}`);
  }
  if (!/^\d+$/.test(String(out.auction || ''))) throw new Error('Thiếu --auction <id>');
  if (!(out.interval > 0)) throw new Error('--interval phải là số giây dương');
  if (!Number.isInteger(out.max) || out.max < 1) throw new Error('--max phải là số nguyên dương');
  return out;
}

// accounts: [{ email, password }]. stopSignal: { stop: boolean } — đặt true để dừng giữa chừng.
// Trả về { bids, reason }.
async function runBidbot({ base, auctionId, accounts, intervalMs, max, log = console.log, stopSignal = { stop: false } }) {
  const api = async (method, path, token, body) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, data: json.data, error: json.error };
  };

  const bots = [];
  for (const { email, password } of accounts) {
    const r = await api('POST', '/auth/login', null, { email, password });
    if (r.status !== 200) { log(`  ✗ ${email}: đăng nhập lỗi (${r.error?.code})`); continue; }
    if (r.data.role !== 'bidder') { log(`  ✗ ${email}: không phải người mua, bỏ qua`); continue; }
    bots.push({ email, token: r.data.token, name: r.data.account.fullName });
    log(`  ✓ đăng nhập ${email}`);
  }
  if (!bots.length) return { bids: 0, reason: 'không đăng nhập được tài khoản demo nào' };

  let bids = 0;
  let turn = 0;
  while (!stopSignal.stop && bids < max) {
    const view = await api('GET', `/auctions/${auctionId}`, bots[0].token);
    if (view.status !== 200) return { bids, reason: `không đọc được phiên (${view.error?.code})` };
    const a = view.data;
    if (a.status !== 'active' || (!a.paused && a.remainingSeconds <= 0)) return { bids, reason: 'phiên đã kết thúc' };
    if (a.paused) { log('  … phiên đang tạm dừng, chờ'); await sleep(intervalMs); continue; }

    // Lần lượt từng bot; bỏ qua bot đang dẫn đầu hoặc không đủ tiền.
    let placed = false;
    for (let k = 0; k < bots.length && !placed; k += 1) {
      const bot = bots[(turn + k) % bots.length];
      const mine = await api('GET', `/auctions/${auctionId}`, bot.token);
      if (mine.status !== 200) continue;
      const d = mine.data;
      if (d.leading) continue;
      const wallet = (await api('GET', '/wallet', bot.token)).data;
      const deposit = d.joined ? d.myDeposit : d.depositRequired;
      // Nếu thắng phải trả được đơn: số dư (sau khi trừ cọc nếu chưa cọc) >= phần còn lại phải trả.
      const balanceAfterJoin = d.joined ? wallet.balance : wallet.balance - d.depositRequired;
      if (balanceAfterJoin < 0 || dueIfWin(d.minNextBid, deposit) > balanceAfterJoin) {
        log(`  - ${bot.email}: không đủ số dư cho giá ${fmt(d.minNextBid)}, bỏ qua`);
        continue;
      }
      if (!d.joined) {
        const j = await api('POST', `/auctions/${auctionId}/join`, bot.token);
        if (j.status !== 201 && j.error?.code !== 'ALREADY_JOINED') { log(`  - ${bot.email}: không đặt cọc được (${j.error?.code})`); continue; }
        log(`  $ ${bot.email} đặt cọc ${fmt(d.depositRequired)}`);
      }
      const b = await api('POST', '/bids', bot.token, { auctionId: String(auctionId), increment: d.bidStep });
      if (b.status === 201) {
        bids += 1;
        placed = true;
        turn = (turn + k + 1) % bots.length;
        log(`  ↑ [${bids}/${max}] ${bot.email} trả ${fmt(b.data.currentPrice)}${b.data.extended ? ' (phiên được gia hạn 30 giây)' : ''}`);
      } else if (['AUCTION_ENDED'].includes(b.error?.code)) {
        return { bids, reason: 'phiên đã kết thúc' };
      } else {
        log(`  - ${bot.email}: không trả giá được (${b.error?.code})`);
      }
    }
    if (!placed) return { bids, reason: 'không bot nào đủ điều kiện trả giá (hết tiền hoặc đều đang dẫn đầu)' };
    if (bids < max && !stopSignal.stop) await sleep(intervalMs);
  }
  return { bids, reason: stopSignal.stop ? 'dừng theo yêu cầu (Ctrl+C)' : `đủ ${max} lượt` };
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Từ chối chạy: NODE_ENV=production. Script chỉ dùng cho môi trường demo.');
    process.exitCode = 1;
    return;
  }
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(err.message);
    console.error('Cách dùng: npm run demo:bidbot -- --auction <id> [--interval 5] [--max 10] [--base http://localhost:5000]');
    process.exitCode = 1;
    return;
  }
  const stopSignal = { stop: false };
  process.on('SIGINT', () => { console.log('\nĐang dừng sau lượt hiện tại...'); stopSignal.stop = true; });

  console.log(`Bot trả giá phiên #${args.auction} tại ${args.base}, mỗi ${args.interval} giây, tối đa ${args.max} lượt`);
  try {
    const r = await runBidbot({
      base: args.base,
      auctionId: args.auction,
      accounts: DEMO_BIDDERS.map((email) => ({ email, password: DEMO_PASSWORD })),
      intervalMs: args.interval * 1000,
      max: args.max,
      stopSignal,
    });
    console.log(`Xong: ${r.bids} lượt giá — ${r.reason}.`);
  } catch (err) {
    console.error(`Lỗi: ${err.cause?.code === 'ECONNREFUSED' ? `không kết nối được ${args.base} (đã chạy npm run dev chưa?)` : err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { runBidbot };
