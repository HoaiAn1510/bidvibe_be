// Dữ liệu demo để app có gì mà hiển thị: tài khoản mẫu + 6 phiên đang diễn ra.
// Mật khẩu mọi tài khoản demo: 123456 (CHỈ dùng cho môi trường demo).
// Chạy lại được nhiều lần: tài khoản/tin đăng đã có thì bỏ qua, phiên còn 'active' được
// gia hạn lại đúng thời lượng ban đầu — dùng khi demo bị hết giờ.
//   node scripts/seed_demo.js
//
// Ảnh phiên demo (listing_photos): Wikimedia Commons, giấy phép tự do, cho phép dùng trực tiếp
// (hotlink) qua thumb.wikimedia.org. Ảnh đầu tiên (order_index 0) là ảnh bìa (coverUrl).
// Chạy lại seed sẽ bổ sung ảnh còn thiếu cho tin demo đã có, không tạo trùng, không xoá gì.
//   Giày "Chicago"   Nike Air Jordan I.jpg — Osyffar, CC0
//                    Air Jordan 2 "Chicago".jpg — HI 622, CC BY-SA 4.0
//   Máy ảnh          Leica m6.jpg — Elya, CC BY-SA 3.0
//                    Leica M6.jpg — Noqqe, CC0
//   Bình gốm         Wine vase, crackled glaze ceramic - Nguyen dynasty ... DSC05323.JPG — Daderot, CC0
//                    Ornamental jar, crackled glaze ceramic - Nguyen dynasty ... DSC05320.JPG — Daderot, CC0
//   Tai nghe         2023 Słuchawki Sennheiser HD 540.jpg — Jacek Halicki, CC BY-SA 4.0
//                    Sennheiser hd-25 headphones.jpg — Bizzarle, CC BY-SA 4.0
//   Giày chạy bộ     Asics Gel-Cumulus 22.jpg — Petar Milošević, CC BY-SA 4.0
//                    Brooks Adrenaline GTS 18.jpg — JSFarman, CC BY-SA 4.0
//   Đồng hồ          Vintage Seiko DX Automatic Wrist Watch ... (11272606543).jpg — Joe Haupt, CC BY-SA 2.0
//                    Vintage Seiko Automatic 17 Jewels Wrist Watch ... (11036409014).jpg — Joe Haupt, CC BY-SA 2.0
// Trang gốc của mỗi ảnh: https://commons.wikimedia.org/wiki/File:<tên file>
const bcrypt = require('bcrypt');
const { pool } = require('../src/config/db');
const walletService = require('../src/services/wallet_service');
const { depositFor, inTransaction } = require('../src/services/auction_engine');
const { ensureBotAccounts, BOT_EMAILS } = require('./demo_bots');

const PASSWORD = '123456';
const H = 3600_000;

const BIDDERS = [
  ['Nguyễn Minh Anh', 'minhanh@gmail.com', '0903 112 233'],
  ['Trần Quốc Việt', 'viet.tran@gmail.com', '0912 445 566'],
  ['Lê Bảo Châu', 'chau.le@outlook.com', '0938 778 899'],
  ['Phạm Gia Hưng', 'hung.pham@gmail.com', '0977 123 456'],
];
const SELLERS = [
  ['Nguyễn Hoàng Long', 'long@sneakersg.vn', 'Sneaker Sài Gòn', 4.9],
  ['Lê Thu Hà', 'ha@phocoxua.vn', 'Phố Cổ Collectibles', 4.9],
  ['Phạm Quốc Bảo', 'bao@retroaudio.vn', 'Retro Audio HN', 4.7],
  ['Đinh Văn Hải', 'hai@retrocamera.vn', 'Retro Camera HN', 4.8],
];
const OPS = [
  ['Lê Thị Ngọc', 'ngoc.le@bidvibe.vn', 'appraiser'],
  ['Phạm Đức Anh', 'anh.pham@bidvibe.vn', 'warehouse'],
  ['Hoàng Gia Bảo', 'admin@bidvibe.vn', 'admin'],
];

// seller = index trong SELLERS; hours = thời lượng còn lại khi seed;
// bids = giá theo thứ tự tăng dần, người đặt luân phiên theo `by` (index trong BIDDERS, bỏ qua 0 = tài khoản demo)
const AUCTIONS = [
  { seller: 0, cat: 'shoes', title: 'Giày retro cao cổ "Chicago" 1985 — size 42', cond: 'Chưa qua sử dụng, đủ hộp',
    desc: 'Phối màu đỏ – trắng – đen kinh điển, đế chưa xuống màu. Kèm hộp gốc và thẻ giấy.',
    start: 3_000_000, hours: 3, bids: [3_050_000, 3_100_000, 3_200_000, 3_400_000, 3_600_000] },
  { seller: 3, cat: 'elec', title: 'Máy ảnh film rangefinder 1984, kèm ống kính 35mm', cond: 'Hoạt động tốt, màn trập chuẩn',
    desc: 'Thân máy kim loại, bọc da nguyên bản. Ống kính không nấm, không xước.',
    start: 9_000_000, hours: 20, bids: [9_050_000, 9_200_000, 9_400_000] },
  { seller: 1, cat: 'antique', title: 'Bình gốm men rạn thời Nguyễn, cao 32cm', cond: 'Nguyên vẹn, không sứt mẻ',
    desc: 'Men rạn tự nhiên, đáy có dấu hiệu lò. Đi kèm giấy chứng nhận của người bán.',
    start: 4_000_000, hours: 30, bids: [4_050_000, 4_150_000, 4_300_000, 4_500_000] },
  { seller: 2, cat: 'elec', title: 'Tai nghe hi-fi Đức thập niên 90, còn hộp', cond: 'Đã qua sử dụng, còn hộp',
    desc: 'Đệm tai mới thay, dây cáp nguyên bản. Âm thanh cân bằng.',
    start: 1_500_000, hours: 40, bids: [1_550_000] },
  { seller: 0, cat: 'shoes', title: 'Giày chạy bộ bản giới hạn, size 43', cond: 'Mới 95%, đã đi 2 lần',
    desc: 'Bản phối màu giới hạn, upper không nhăn. Kèm hộp.', start: 1_200_000, hours: 52, bids: [] },
  { seller: 1, cat: 'antique', title: 'Đồng hồ cơ Nhật Bản 1972, dây da nguyên bản', cond: 'Chạy chuẩn, mặt số nguyên bản',
    desc: 'Vỏ thép có vài vết xước nhỏ đúng tuổi. Máy lên cót tay, trữ cót tốt.',
    start: 3_000_000, hours: 70, bids: [3_050_000, 3_150_000] },
];

// Ảnh theo tiêu đề tin; phần tử đầu là ảnh bìa. Nguồn và giấy phép: xem đầu file.
const WM = 'https://thumb.wikimedia.org/wikipedia/commons/thumb';
const PHOTOS = {
  'Giày retro cao cổ "Chicago" 1985 — size 42': [
    `${WM}/2/2a/Nike_Air_Jordan_I.jpg/960px-Nike_Air_Jordan_I.jpg`,
    `${WM}/d/d4/Air_Jordan_2_%22Chicago%22.jpg/960px-Air_Jordan_2_%22Chicago%22.jpg`,
  ],
  'Máy ảnh film rangefinder 1984, kèm ống kính 35mm': [
    `${WM}/c/ce/Leica_m6.jpg/960px-Leica_m6.jpg`,
    `${WM}/e/e4/Leica_M6.jpg/960px-Leica_M6.jpg`,
  ],
  'Bình gốm men rạn thời Nguyễn, cao 32cm': [
    `${WM}/9/97/Wine_vase%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05323.JPG/960px-Wine_vase%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05323.JPG`,
    `${WM}/1/19/Ornamental_jar%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05320.JPG/960px-Ornamental_jar%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05320.JPG`,
  ],
  'Tai nghe hi-fi Đức thập niên 90, còn hộp': [
    `${WM}/9/9e/2023_S%C5%82uchawki_Sennheiser_HD_540.jpg/960px-2023_S%C5%82uchawki_Sennheiser_HD_540.jpg`,
    `${WM}/a/a2/Sennheiser_hd-25_headphones.jpg/960px-Sennheiser_hd-25_headphones.jpg`,
  ],
  'Giày chạy bộ bản giới hạn, size 43': [
    `${WM}/8/8b/Asics_Gel-Cumulus_22.jpg/960px-Asics_Gel-Cumulus_22.jpg`,
    `${WM}/b/b2/Brooks_Adrenaline_GTS_18.jpg/960px-Brooks_Adrenaline_GTS_18.jpg`,
  ],
  'Đồng hồ cơ Nhật Bản 1972, dây da nguyên bản': [
    `${WM}/5/58/Vintage_Seiko_DX_Automatic_Wrist_Watch%2C_25_Jewels%2C_Made_in_Japan_%2811272606543%29.jpg/960px-Vintage_Seiko_DX_Automatic_Wrist_Watch%2C_25_Jewels%2C_Made_in_Japan_%2811272606543%29.jpg`,
    `${WM}/5/5a/Vintage_Seiko_Automatic_17_Jewels_Wrist_Watch%2C_Made_in_Japan_%2811036409014%29.jpg/960px-Vintage_Seiko_Automatic_17_Jewels_Wrist_Watch%2C_Made_in_Japan_%2811036409014%29.jpg`,
  ],
};

// Thêm ảnh còn thiếu cho một tin (so theo URL), giữ nguyên ảnh đã có. Trả về số ảnh vừa thêm.
async function ensurePhotos(client, listingId, urls = []) {
  let added = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const r = await client.query(
      `INSERT INTO listing_photos (listing_id, url, order_index)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM listing_photos WHERE listing_id = $1 AND url = $2)`,
      [listingId, urls[i], i],
    );
    added += r.rowCount;
  }
  return added;
}

// Tài khoản demo đã có mà mật khẩu không còn là mật khẩu demo (ai đó đổi qua POST /api/me/password)
// thì đặt lại. Chỉ chạm đúng dòng của email demo; không đổi số dư hay dữ liệu khác.
let passwordResets = 0;
async function resetDemoPassword(client, table, email) {
  const { rows } = await client.query(`SELECT id, password_hash FROM ${table} WHERE lower(email) = $1`, [email]);
  if (!rows[0] || (rows[0].password_hash && await bcrypt.compare(PASSWORD, rows[0].password_hash))) return;
  await client.query(`UPDATE ${table} SET password_hash = $2 WHERE id = $1`, [rows[0].id, await bcrypt.hash(PASSWORD, 10)]);
  passwordResets += 1;
}

async function ensureAccount(client, [fullName, email, phone], role, extra) {
  const found = await client.query('SELECT id FROM accounts WHERE lower(email) = $1', [email]);
  if (found.rows[0]) {
    await resetDemoPassword(client, 'accounts', email);
    return { id: found.rows[0].id, created: false };
  }
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { rows } = await client.query(
    'INSERT INTO accounts (full_name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [fullName, email, phone || null, hash],
  );
  const id = rows[0].id;
  if (role === 'bidder') {
    await client.query('INSERT INTO bidders (account_id) VALUES ($1)', [id]);
  } else {
    await client.query('INSERT INTO sellers (account_id, store_name, rating) VALUES ($1, $2, $3)', [id, extra.shop, extra.rating]);
  }
  return { id, created: true };
}

async function main() {
  await inTransaction(async (client) => {
    const bidders = [];
    for (const b of BIDDERS) {
      const { id, created } = await ensureAccount(client, b, 'bidder');
      if (created) await walletService.topUp(client, { bidderId: id, amount: 20_000_000 });
      bidders.push(id);
    }
    // Tài khoản riêng cho bot đấu giá demo (bot1..3@bidvibe.demo), xem scripts/demo_bots.js
    const bots = await ensureBotAccounts(client);
    if (bots) console.log(`  + ${bots} tài khoản bot đấu giá`);
    // Bot đã có: chỉ đặt lại mật khẩu, giữ nguyên số dư ví.
    for (const email of BOT_EMAILS) await resetDemoPassword(client, 'accounts', email);
    const sellers = [];
    for (const [name, email, shop, rating] of SELLERS) {
      sellers.push((await ensureAccount(client, [name, email, null], 'seller', { shop, rating })).id);
    }
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [name, email, role] of OPS) {
      await client.query(
        `INSERT INTO ops_accounts (name, email, role, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [name, email, role, hash],
      );
      await resetDemoPassword(client, 'ops_accounts', email);
    }

    const cats = Object.fromEntries((await client.query('SELECT code, id FROM categories')).rows.map((r) => [r.code, r.id]));

    for (const a of AUCTIONS) {
      const sellerId = sellers[a.seller];
      const existing = await client.query(
        `SELECT l.id AS listing_id, au.id AS auction_id, au.status
         FROM listings l LEFT JOIN auctions au ON au.listing_id = l.id
         WHERE l.seller_id = $1 AND l.title = $2`,
        [sellerId, a.title],
      );
      if (existing.rows[0]) {
        const { listing_id: listingId, auction_id: auctionId, status } = existing.rows[0];
        const added = await ensurePhotos(client, listingId, PHOTOS[a.title]);
        if (added) console.log(`  + ${added} ảnh: ${a.title}`);
        if (auctionId && status === 'active') {
          await client.query(`UPDATE auctions SET ends_at = now() + ($2 || ' hours')::interval WHERE id = $1`, [auctionId, String(a.hours)]);
          console.log(`  ↻ gia hạn: ${a.title}`);
        }
        continue;
      }

      const listing = await client.query(
        `INSERT INTO listings (seller_id, category_id, title, description, condition, starting_price, duration_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'live') RETURNING id`,
        [sellerId, cats[a.cat], a.title, a.desc, a.cond, a.start, a.hours + 48],
      );
      await ensurePhotos(client, listing.rows[0].id, PHOTOS[a.title]);
      const deposit = depositFor(a.start);
      const last = a.bids.length ? a.bids[a.bids.length - 1] : a.start;
      const au = await client.query(
        `INSERT INTO auctions (listing_id, current_price, bid_step, deposit_required, starts_at, ends_at, bid_count)
         VALUES ($1, $2, 50000, $3, now() - interval '2 days', now() + ($4 || ' hours')::interval, $5) RETURNING id`,
        [listing.rows[0].id, last, deposit, String(a.hours), a.bids.length],
      );
      const auctionId = au.rows[0].id;

      // Người đặt giá luân phiên giữa 3 bidder phụ (không dùng tài khoản demo chính, để bạn tự đặt giá).
      const others = bidders.slice(1);
      const joined = new Set();
      for (let i = 0; i < a.bids.length; i += 1) {
        const who = others[i % others.length];
        if (!joined.has(who)) {
          joined.add(who);
          await client.query('INSERT INTO auction_deposits (auction_id, bidder_id, amount) VALUES ($1, $2, $3)', [auctionId, who, deposit]);
          await walletService.holdDeposit(client, { bidderId: who, auctionId, amount: deposit });
        }
        await client.query(
          `INSERT INTO bids (auction_id, bidder_id, amount, created_at)
           VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
          [auctionId, who, a.bids[i], String((a.bids.length - i) * 20)],
        );
      }
      console.log(`  + ${a.title}`);
    }
  });
  if (passwordResets) console.log(`  ↻ đặt lại mật khẩu ${PASSWORD} cho ${passwordResets} tài khoản demo`);
  console.log(`\nXong. Đăng nhập thử: minhanh@gmail.com / ${PASSWORD} (người mua, ví 20.000.000đ)`);
}

main()
  .catch((err) => { console.error('Seed lỗi:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
