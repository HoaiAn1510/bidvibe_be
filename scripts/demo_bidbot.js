// Giả lập vài người mua lần lượt trả giá một phiên, để màn hình app thấy giá nhảy theo thời gian
// thực (Socket.io auction:update). Đi qua API thật của server đang chạy (đăng nhập, đặt cọc, đặt
// giá) — không ghi thẳng vào bảng.
//
//   npm run dev                                         (một terminal khác)
//   npm run demo:bidbot -- --auction 871 [--interval 5] [--max 10] [--stop-before 60] [--only-outbid]
//                                        [--bots bot1@bidvibe.demo,bot2@bidvibe.demo] [--base http://localhost:5000]
//
// An toàn:
// - CHỈ dùng 3 tài khoản bot riêng bot1..3@bidvibe.demo (scripts/demo_bots.js, tạo bằng npm run db:seed
//   hoặc db:seed:live). Chỉ định tài khoản khác, hoặc thiếu tài khoản bot -> từ chối chạy.
// - Tự đặt cọc nếu chưa cọc. Chỉ trả giá khi số dư còn đủ trả đơn nếu thắng
//   (giá + phí 5% + vận chuyển - cọc), nên không bao giờ dùng quá số dư ví.
// - Hạn chế bot thắng phiên: không trả giá khi phiên còn dưới --stop-before giây (mặc định 60);
//   --only-outbid: chỉ trả giá khi NGƯỜI KHÁC (không phải bot) đang dẫn đầu.
// - Dừng khi đủ --max lượt, phiên hết giờ / bị huỷ / còn dưới --stop-before giây, không bot nào
//   đủ tiền, hoặc Ctrl+C. Từ chối chạy khi NODE_ENV=production.
const { BOT_ACCOUNTS, BOT_EMAILS, BOT_PASSWORD } = require('./demo_bots');

const FEE_RATE = 0.05; // khớp auction_engine.js
const SHIPPING_FEE = 40_000;

const fmt = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Số tiền phải trả thêm nếu thắng ở giá `price` (đã trừ cọc) — cùng công thức với đơn hàng.
const dueIfWin = (price, deposit) => price + Math.round((price * FEE_RATE) / 1000) * 1000 + SHIPPING_FEE - deposit;

function parseArgs(argv) {
  const out = { interval: 5, max: 10, stopBefore: 60, onlyOutbid: false, bots: BOT_EMAILS, base: `http://localhost:${process.env.PORT || 5000}` };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--only-outbid') { out.onlyOutbid = true; continue; }
    if (!['--auction', '--interval', '--max', '--stop-before', '--bots', '--base'].includes(k)) throw new Error(`Tham số không hợp lệ: ${k}`);
    if (v === undefined) throw new Error(`Thiếu giá trị cho ${k}`);
    i += 1;
    if (k === '--auction') out.auction = v;
    else if (k === '--interval') out.interval = Number(v);
    else if (k === '--max') out.max = Number(v);
    else if (k === '--stop-before') out.stopBefore = Number(v);
    else if (k === '--bots') out.bots = v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    else out.base = v;
  }
  if (!/^\d+$/.test(String(out.auction || ''))) throw new Error('Thiếu --auction <id>');
  if (!(out.interval > 0)) throw new Error('--interval phải là số giây dương');
  if (!Number.isInteger(out.max) || out.max < 1) throw new Error('--max phải là số nguyên dương');
  if (!(out.stopBefore >= 0)) throw new Error('--stop-before phải là số giây không âm');
  if (!out.bots.length) throw new Error('--bots không được rỗng');
  return out;
}

// accounts: [{ email, password }], mọi email phải nằm trong allowedEmails (mặc định 3 bot demo).
// stopSignal: { stop: boolean } — đặt true để dừng giữa chừng. Trả về { bids, reason }.
async function runBidbot({
  base, auctionId, accounts, intervalMs, max, stopBeforeSeconds = 60, onlyOutbid = false,
  allowedEmails = BOT_EMAILS, log = console.log, stopSignal = { stop: false },
}) {
  const allowed = new Set(allowedEmails.map((e) => e.toLowerCase()));
  const notAllowed = accounts.filter((a) => !allowed.has(String(a.email).toLowerCase()));
  if (!accounts.length || notAllowed.length) {
    return { bids: 0, reason: `từ chối: chỉ được dùng tài khoản bot (${[...allowed].join(', ')})${notAllowed.length ? `, không dùng ${notAllowed.map((a) => a.email).join(', ')}` : ''}` };
  }

  const api = async (method, path, token, body) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, data: json.data, error: json.error };
  };

  // Mọi tài khoản bot phải đăng nhập được; thiếu một cái là dừng, không chạy nửa vời.
  const bots = [];
  for (const { email, password } of accounts) {
    const r = await api('POST', '/auth/login', null, { email, password });
    if (r.status !== 200 || r.data.role !== 'bidder') {
      return { bids: 0, reason: `từ chối: không đăng nhập được tài khoản bot ${email} (${r.error?.code || r.data?.role}) — chạy npm run db:seed:live để tạo bot` };
    }
    bots.push({ email, token: r.data.token });
    log(`  ✓ đăng nhập ${email}`);
  }

  let bids = 0;
  let turn = 0;
  while (!stopSignal.stop && bids < max) {
    // Trạng thái phiên theo góc nhìn từng bot (để biết bot nào đang dẫn đầu).
    const views = [];
    for (const bot of bots) {
      const v = await api('GET', `/auctions/${auctionId}`, bot.token);
      if (v.status !== 200) return { bids, reason: `không đọc được phiên (${v.error?.code})` };
      views.push(v.data);
    }
    const a = views[0];
    if (a.status !== 'active' || (!a.paused && a.remainingSeconds <= 0)) return { bids, reason: 'phiên đã kết thúc' };
    if (a.paused) { log('  … phiên đang tạm dừng, chờ'); await sleep(intervalMs); continue; }
    if (a.remainingSeconds < stopBeforeSeconds) {
      return { bids, reason: `phiên còn dưới ${stopBeforeSeconds} giây, bot dừng để không thắng phiên` };
    }
    const botLeading = views.some((v) => v.leading);
    if (onlyOutbid && (botLeading || a.bidCount === 0)) {
      log(`  … chờ người khác dẫn đầu (${a.bidCount === 0 ? 'chưa có lượt giá' : 'bot đang dẫn đầu'})`);
      await sleep(intervalMs);
      continue;
    }

    // Lần lượt từng bot; bỏ qua bot đang dẫn đầu hoặc không đủ tiền.
    let placed = false;
    for (let k = 0; k < bots.length && !placed; k += 1) {
      const idx = (turn + k) % bots.length;
      const bot = bots[idx];
      const d = views[idx];
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
        turn = (idx + 1) % bots.length;
        log(`  ↑ [${bids}/${max}] ${bot.email} trả ${fmt(b.data.currentPrice)}${b.data.extended ? ' (phiên được gia hạn 30 giây)' : ''}`);
      } else if (b.error?.code === 'AUCTION_ENDED') {
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
    console.error('Cách dùng: npm run demo:bidbot -- --auction <id> [--interval 5] [--max 10] [--stop-before 60] [--only-outbid] [--bots bot1@bidvibe.demo,...] [--base http://localhost:5000]');
    process.exitCode = 1;
    return;
  }
  const notBots = args.bots.filter((e) => !BOT_EMAILS.includes(e));
  if (notBots.length) {
    console.error(`Từ chối chạy: chỉ được dùng tài khoản bot (${BOT_EMAILS.join(', ')}), không dùng ${notBots.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const stopSignal = { stop: false };
  process.on('SIGINT', () => { console.log('\nĐang dừng sau lượt hiện tại...'); stopSignal.stop = true; });

  console.log(`Bot trả giá phiên #${args.auction} tại ${args.base}: mỗi ${args.interval} giây, tối đa ${args.max} lượt, `
    + `dừng khi còn dưới ${args.stopBefore} giây${args.onlyOutbid ? ', chỉ khi người khác dẫn đầu' : ''}`);
  try {
    const r = await runBidbot({
      base: args.base,
      auctionId: args.auction,
      accounts: BOT_ACCOUNTS.filter((b) => args.bots.includes(b.email)).map(({ email }) => ({ email, password: BOT_PASSWORD })),
      intervalMs: args.interval * 1000,
      max: args.max,
      stopBeforeSeconds: args.stopBefore,
      onlyOutbid: args.onlyOutbid,
      stopSignal,
    });
    console.log(`Xong: ${r.bids} lượt giá — ${r.reason}.`);
    if (r.reason.startsWith('từ chối')) process.exitCode = 1;
  } catch (err) {
    console.error(`Lỗi: ${err.cause?.code === 'ECONNREFUSED' ? `không kết nối được ${args.base} (đã chạy npm run dev chưa?)` : err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { runBidbot };
