// Nghe kênh Postgres 'auction_pause' (migration 007) và đẩy `auction:update` vào phòng
// auction:{id} khi phiên bị tạm dừng / tiếp tục. Trigger gửi thông báo sau COMMIT, dù
// ai đổi cờ (Admin của BE2 hay máy chủ khác cùng trỏ vào DB), nên BE2 không phải gọi gì.
// Dùng một kết nối riêng (LISTEN cần giữ phiên): Supabase Session pooler hỗ trợ việc này.
// Cùng kết nối đó LISTEN thêm kênh 'bidvibe_events' (sockets/broadcast.js): sự kiện do backend khác
// cùng database phát (auction:update, auction:ended, notification:new, lệnh ngắt tài khoản) được
// phát lại cho socket của tiến trình này. Mỗi tiến trình: pool + đúng 1 kết nối LISTEN.
const { Client } = require('pg');
const env = require('../config/env');
const { pool } = require('../config/db');
const auctionModel = require('../models/auction.model');
const registerSockets = require('./index');
const realtime = require('./broadcast');

const CHANNEL = 'auction_pause';
const RETRY_MS = 5000;

let client = null;
let stopped = true;
let retryTimer = null;

// Dữ liệu `auction:update` khi đổi trạng thái tạm dừng. Đọc lại phiên từ DB (đã COMMIT)
// để giờ kết thúc luôn là giá trị sau khi trigger cộng bù thời gian đã dừng.
async function buildPauseUpdate(auctionId) {
  const a = await auctionModel.findById(pool, auctionId);
  if (!a) return null;
  return {
    auctionId: String(a.id),
    reason: a.paused ? 'paused' : 'resumed',
    status: a.status,
    paused: a.paused,
    pausedAt: a.pausedAt,
    endsAt: a.endsAt,
    remainingSeconds: a.remainingSeconds,
    currentPrice: a.currentPrice,
    bidCount: a.bidCount,
  };
}

// Tin từ backend khác: phát lại vào phòng, hoặc chạy lệnh ngắt tài khoản. Tin của chính mình bỏ qua.
async function onEvent(text) {
  try {
    const m = JSON.parse(text);
    if (m.origin === realtime.ORIGIN) return;
    if (m.command === 'disconnect') {
      await registerSockets.disconnectLocal(m.accountId, { kind: m.kind, reason: m.reason || undefined });
      return;
    }
    if (m.room && m.event) realtime.emitLocal(m.room, m.event, m.payload);
  } catch (err) {
    console.error('[realtime]', err.message);
  }
}

async function onNotification(msg) {
  if (msg.channel === realtime.CHANNEL) return onEvent(msg.payload);
  if (msg.channel !== CHANNEL) return;
  try {
    const { auctionId } = JSON.parse(msg.payload);
    const update = await buildPauseUpdate(auctionId);
    if (update) realtime.emitLocal(`auction:${update.auctionId}`, 'auction:update', update); // thêm serverTime
  } catch (err) {
    console.error('[pause-listener]', err.message);
  }
}

function scheduleReconnect() {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect().catch((err) => { console.error('[pause-listener] kết nối lại lỗi:', err.message); scheduleReconnect(); });
  }, RETRY_MS);
}

async function connect() {
  const c = new Client({ connectionString: env.databaseUrl, ssl: env.dbSsl ? { rejectUnauthorized: false } : false });
  c.on('notification', onNotification);
  c.on('error', (err) => { console.error('[pause-listener]', err.message); });
  c.on('end', () => { if (client === c) client = null; scheduleReconnect(); });
  await c.connect();
  await c.query(`LISTEN ${CHANNEL}`);
  await c.query(`LISTEN ${realtime.CHANNEL}`);
  if (stopped) { await c.end(); return; }
  client = c;
  console.log('[realtime] đang nghe sự kiện từ các backend khác cùng database');
}

// Gọi khi server bắt đầu lắng nghe (app.js). Trả về Promise khi đã LISTEN xong.
async function start() {
  if (!stopped) return;
  stopped = false;
  try {
    await connect();
  } catch (err) {
    console.error('[pause-listener] không kết nối được, thử lại sau:', err.message);
    scheduleReconnect();
  }
}

async function stop() {
  stopped = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const c = client;
  client = null;
  if (c) await c.end().catch(() => {});
}

module.exports = { start, stop };
