// Seed dữ liệu demo phần Marketplace Operations (BE2), chạy SAU scripts/seed_demo.js (BE1).
// Database dùng chung giữa BE1 và BE2 nên seed này idempotent:
//   - tài khoản khoá theo email, tin đăng khoá theo (người bán, tiêu đề), cờ theo (phiên, lý do);
//   - đã có thì bỏ qua, không sửa / xoá dữ liệu sẵn có;
//   - toàn bộ chạy trong MỘT giao dịch: lỗi giữa chừng thì không để lại dữ liệu dở dang.
// Tiền ví đi qua wallet_service (BE1), phiên sinh bằng createAuctionForListing (BE1), nên
// wallet_transactions luôn khớp số dư. Mật khẩu demo: 123456 (CHỈ dùng cho môi trường demo).
//   node scripts/seed.js        (hoặc npm run db:seed để chạy cả seed của BE1 lẫn BE2)
const bcrypt = require('bcrypt');
const { pool } = require('../src/config/db');
const walletService = require('../src/services/wallet_service');
const { inTransaction, createAuctionForListing } = require('../src/services/auction_engine');
const { createNotification } = require('../src/services/notification_service');

const PASSWORD = '123456';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const FEE_RATE = 0.05;      // khớp auction_engine (phí dịch vụ 5%)
const SHIPPING_FEE = 40_000; // khớp auction_engine
const roundThousand = (n) => Math.round(n / 1000) * 1000;
const totalDueFor = (price) => price + roundThousand(price * FEE_RATE) + SHIPPING_FEE;
const photo = (slug, i) => `https://picsum.photos/seed/bidvibe-${slug}-${i}/800/600`;

// ---------- Tài khoản (khớp dữ liệu giả trong app Flutter, lib/store.dart) ----------

const BIDDERS = [
  ['Nguyễn Minh Anh', 'minhanh@gmail.com', '0903 112 233'],
  ['Trần Quốc Việt', 'viet.tran@gmail.com', '0912 445 566'],
  ['Lê Bảo Châu', 'chau.le@outlook.com', '0938 778 899'],
  ['Phạm Gia Hưng', 'hung.pham@gmail.com', '0977 123 456'],
];
const SELLERS = [
  ['Nguyễn Hoàng Long', 'long@sneakersg.vn', '0908 556 120', 'Sneaker Sài Gòn', 4.9],
  ['Lê Thu Hà', 'ha@phocoxua.vn', '0983 220 415', 'Phố Cổ Collectibles', 4.9],
  ['Phạm Quốc Bảo', 'bao@retroaudio.vn', '0972 665 308', 'Retro Audio HN', 4.7],
  ['Đinh Văn Hải', 'hai@retrocamera.vn', '0945 118 763', 'Retro Camera HN', 4.8],
  ['Nông Thị Hoa', 'hoa@caonguyenxua.vn', '0916 440 297', 'Cao Nguyên Xưa', null],
];
// [tên, email, role, status, weekly_load]
const OPS = [
  ['Trần Minh Khoa', 'khoa.tran@bidvibe.vn', 'appraiser', 'active', 34],
  ['Lê Thị Ngọc', 'ngoc.le@bidvibe.vn', 'appraiser', 'active', 28],
  ['Đỗ Quang Huy', 'huy.do@bidvibe.vn', 'appraiser', 'active', 19],
  ['Phạm Đức Anh', 'anh.pham@bidvibe.vn', 'warehouse', 'active', 41],
  ['Vũ Hải Yến', 'yen.vu@bidvibe.vn', 'warehouse', 'suspended', 0],
  ['Ngô Thanh Sơn', 'son.ngo@bidvibe.vn', 'warehouse', 'active', 37],
  ['Hoàng Gia Bảo', 'admin@bidvibe.vn', 'admin', 'active', 0],
  ['Đặng Thu Trang', 'trang.dang@bidvibe.vn', 'admin', 'active', 0],
  ['Võ Minh Tuấn', 'tuan.vo@bidvibe.vn', 'admin', 'active', 0],
];

// ---------- Tin đăng đang trong quy trình thẩm định (chưa có phiên) ----------
// status: draft | pending_appraisal | needs_info | rejected
const PIPELINE_LISTINGS = [
  { seller: 'ha@phocoxua.vn', cat: 'antique', title: 'Chén trà men ngọc thời Nguyễn', start: 3_500_000,
    cond: 'Nguyên vẹn', desc: 'Chén trà men ngọc, đường kính 8cm. Người bán khai báo nguyên vẹn, không sứt mẻ.',
    status: 'pending_appraisal', photos: 3, ai: 3_600_000 },
  { seller: 'long@sneakersg.vn', cat: 'shoes', title: 'Giày bóng rổ cổ điển, size 44', start: 2_900_000,
    cond: 'Như mới', desc: 'Đế có dấu hiệu ố vàng nhẹ theo thời gian, chưa qua sửa chữa.',
    status: 'pending_appraisal', photos: 2, ai: 2_750_000 },
  { seller: 'hoa@caonguyenxua.vn', cat: 'antique', title: 'Vòng cổ bạc chạm khắc dân tộc', start: 2_200_000,
    cond: 'Đã qua sử dụng', desc: 'Người bán mới có ít phiên, đây là phiên ký gửi vòng cổ đầu tiên.',
    status: 'pending_appraisal', photos: 3, ai: 2_100_000 },
  { seller: 'bao@retroaudio.vn', cat: 'elec', title: 'Tai nghe không dây phiên bản giới hạn', start: 3_100_000,
    cond: 'Như mới', desc: 'Còn bảo hành hãng 3 tháng, hộp hơi móp góc.',
    status: 'pending_appraisal', photos: 4, ai: 3_000_000 },
  { seller: 'bao@retroaudio.vn', cat: 'elec', title: 'Máy nghe nhạc cassette Nhật Bản, 1988', start: 1_800_000,
    cond: 'Đã qua sử dụng', desc: 'Còn chạy băng, cửa băng hơi lỏng. Đủ dây sạc gốc.',
    status: 'needs_info', photos: 4, ai: 1_700_000,
    appraisal: { by: 'khoa.tran@bidvibe.vn', decision: 'more_info',
      reason: 'Chụp thêm ảnh chi tiết/vết hư hỏng; Ảnh cận số seri / mã sản phẩm' } },
  { seller: 'long@sneakersg.vn', cat: 'shoes', title: 'Giày thể thao phối màu "Mexico 66", size 40', start: 1_600_000,
    cond: 'Đã qua sử dụng', desc: 'Giày đã đi vài lần, còn hộp.',
    status: 'rejected', photos: 2, ai: 1_400_000,
    appraisal: { by: 'ngoc.le@bidvibe.vn', decision: 'reject',
      reason: 'Ảnh không thấy rõ tem size và mã sản xuất, không xác thực được hàng chính hãng.' } },
  { seller: 'hai@retrocamera.vn', cat: 'elec', title: 'Máy ảnh Polaroid SX-70 bản gập', start: 4_200_000,
    cond: 'Hoạt động tốt', desc: 'Người bán đang soạn tin, chưa gửi thẩm định.',
    status: 'draft', photos: 1, ai: 4_000_000 },
];

// ---------- Phiên đã kết thúc -> đơn hàng ở mọi trạng thái kho ----------
// stage: awaiting_payment | waiting | inspecting | inspecting_done | packed | shipped |
//        delivered | completed | escalated
const SOLD = [
  { seller: 'bao@retroaudio.vn', cat: 'elec', title: 'Radio bóng đèn Philips 1960, vỏ gỗ óc chó',
    start: 2_000_000, price: 3_650_000, winner: 'minhanh@gmail.com', loser: 'viet.tran@gmail.com',
    stage: 'awaiting_payment', code: 'BV-071026-01', endedAgo: 2 * HOUR },
  { seller: 'ha@phocoxua.vn', cat: 'antique', title: 'Đèn dầu hoả Đức cổ, chụp thuỷ tinh nguyên bản',
    start: 1_200_000, price: 1_700_000, winner: 'hung.pham@gmail.com', loser: 'chau.le@outlook.com',
    stage: 'waiting', code: 'BV-300926-04', endedAgo: 2 * DAY },
  { seller: 'hai@retrocamera.vn', cat: 'elec', title: 'Ống kính Helios 44-2 58mm f/2',
    start: 1_000_000, price: 1_450_000, winner: 'chau.le@outlook.com', loser: 'hung.pham@gmail.com',
    stage: 'waiting', code: 'BV-300926-02', endedAgo: 2 * DAY },
  { seller: 'ha@phocoxua.vn', cat: 'antique', title: 'Ấm tử sa Nghi Hưng thập niên 70, dáng tây thi',
    start: 2_500_000, price: 3_300_000, winner: 'chau.le@outlook.com', loser: 'minhanh@gmail.com',
    stage: 'inspecting', code: 'BV-280926-02', endedAgo: 4 * DAY },
  { seller: 'long@sneakersg.vn', cat: 'shoes', title: 'Giày cao cổ da lộn, size 40',
    start: 2_000_000, price: 2_750_000, winner: 'viet.tran@gmail.com', loser: 'hung.pham@gmail.com',
    stage: 'inspecting_done', code: 'BV-270926-01', endedAgo: 5 * DAY, grade: 'Tốt', shelf: 'Kệ B2-04' },
  { seller: 'bao@retroaudio.vn', cat: 'elec', title: 'Loa bookshelf Đức thập niên 80 (cặp)',
    start: 3_500_000, price: 4_500_000, winner: 'viet.tran@gmail.com', loser: 'chau.le@outlook.com',
    stage: 'packed', code: 'BV-250926-05', endedAgo: 6 * DAY, grade: 'Như mới', shelf: 'Kệ A1-02' },
  { seller: 'bao@retroaudio.vn', cat: 'elec', title: 'Đầu đĩa than Sanyo 1979',
    start: 3_000_000, price: 3_900_000, winner: 'hung.pham@gmail.com', loser: 'viet.tran@gmail.com',
    stage: 'shipped', code: 'BV-240926-02', endedAgo: 7 * DAY, grade: 'Tốt', shelf: 'Kệ A2-05',
    carrier: 'Viettel Post', tracking: 'VIETTEL5081127390' },
  { seller: 'bao@retroaudio.vn', cat: 'elec', title: 'Máy chơi game cầm tay đời đầu, đủ hộp',
    start: 1_200_000, price: 1_850_000, winner: 'minhanh@gmail.com', loser: 'hung.pham@gmail.com',
    stage: 'delivered', code: 'BV-220926-02', endedAgo: 9 * DAY, grade: 'Tốt', shelf: 'Kệ C3-02',
    carrier: 'GHN Express', tracking: 'GHN7290365512', deliveredAgo: 5 * HOUR },
  { seller: 'long@sneakersg.vn', cat: 'shoes', title: 'Giày da Oxford thủ công, size 41',
    start: 1_500_000, price: 2_150_000, winner: 'minhanh@gmail.com', loser: 'viet.tran@gmail.com',
    stage: 'completed', code: 'BV-160926-04', endedAgo: 15 * DAY, grade: 'Như mới', shelf: 'Kệ B1-01',
    carrier: 'GHN Express', tracking: 'GHN7104418826', deliveredAgo: 4 * DAY },
  { seller: 'ha@phocoxua.vn', cat: 'antique', title: 'Bộ ly pha lê Bohemia (6 chiếc)',
    start: 2_500_000, price: 3_200_000, winner: 'chau.le@outlook.com', loser: 'viet.tran@gmail.com',
    stage: 'escalated', code: 'BV-260926-03', endedAgo: 6 * DAY,
    mismatch: 'Thiếu 1 chiếc so với mô tả (nhận 5/6), một chiếc có vết mẻ ở miệng ly.' },
  { seller: 'hai@retrocamera.vn', cat: 'elec', title: 'Máy ảnh compact Olympus XA 1979',
    start: 5_000_000, price: 6_800_000, winner: 'viet.tran@gmail.com', loser: 'chau.le@outlook.com',
    stage: 'delivered', code: 'BV-200926-01', endedAgo: 11 * DAY, grade: 'Tốt', shelf: 'Kệ C1-03',
    carrier: 'GHN Express', tracking: 'GHN7188204471', deliveredAgo: 30 * HOUR, disputedByBidder: true },
  { seller: 'hoa@caonguyenxua.vn', cat: 'antique', title: 'Bộ chén bạc chạm khắc hoạ tiết',
    start: 1_800_000, price: 2_300_000, winner: 'hung.pham@gmail.com', loser: 'minhanh@gmail.com',
    stage: 'waiting', code: 'BV-300926-05', endedAgo: 1 * DAY, disputedBySeller: true },
  { seller: 'bao@retroaudio.vn', cat: 'elec', title: 'Máy nghe nhạc Walkman Sony 1985',
    start: 1_000_000, price: 1_600_000, winner: 'chau.le@outlook.com', loser: 'hung.pham@gmail.com',
    stage: 'completed', code: 'BV-120926-03', endedAgo: 20 * DAY, grade: 'Khá', shelf: 'Kệ C2-01',
    carrier: 'GHN Express', tracking: 'GHN7011938274', deliveredAgo: 12 * DAY, resolvedDispute: true },
];

// ---------- Cờ AI trên các phiên đang diễn ra (do scripts/seed_demo.js tạo) ----------
const FLAGS = [
  { title: 'Giày retro cao cổ "Chicago" 1985 — size 42', severity: 'high', confidence: 91, status: 'pending',
    reason: 'Hai tài khoản đặt giá luân phiên',
    explain: 'Hai tài khoản luân phiên vượt giá nhau 6 lần liên tiếp, cách nhau dưới 40 giây, đăng nhập từ cùng một dải IP.',
    evidence: [['Số lượt luân phiên', '6'], ['Khoảng cách trung bình', '34 giây'], ['Dải IP chung', '113.161.x.x']] },
  { title: 'Máy ảnh film rangefinder 1984, kèm ống kính 35mm', severity: 'high', confidence: 87, status: 'pending',
    reason: 'Đặt giá dồn dập theo nhịp đều',
    explain: 'Các lượt đặt giá cách nhau gần như đúng 60 giây, dấu hiệu của công cụ tự động.',
    evidence: [['Độ lệch nhịp đặt giá', '±2 giây'], ['Số lượt trong 10 phút', '9']] },
  { title: 'Bình gốm men rạn thời Nguyễn, cao 32cm', severity: 'medium', confidence: 68, status: 'pending',
    reason: 'Giá thấp hơn mặt bằng chung',
    explain: 'Giá khởi điểm thấp hơn 45% so với các phiên đồ gốm cùng loại đã kết thúc.',
    evidence: [['Giá khởi điểm', '4.000.000đ'], ['Trung vị phiên tương tự', '7.300.000đ']] },
  { title: 'Đồng hồ cơ Nhật Bản 1972, dây da nguyên bản', severity: 'low', confidence: 54, status: 'verify',
    reason: 'Người bán huỷ nhiều phiên liên tiếp',
    explain: 'Người bán đã huỷ 3 phiên trong 30 ngày; cần xác minh trước khi phiên kết thúc.',
    evidence: [['Số phiên huỷ / 30 ngày', '3']] },
];

// ---------- Helpers ----------

async function ensureAccount(client, hash, { fullName, email, phone, role, shop, rating }) {
  const found = await client.query('SELECT id FROM accounts WHERE lower(email) = $1', [email]);
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const { rows } = await client.query(
    'INSERT INTO accounts (full_name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [fullName, email, phone, hash],
  );
  const { id } = rows[0];
  if (role === 'bidder') {
    await client.query('INSERT INTO bidders (account_id) VALUES ($1)', [id]);
  } else {
    await client.query(
      'INSERT INTO sellers (account_id, store_name, rating) VALUES ($1, $2, $3)',
      [id, shop, rating],
    );
  }
  return { id, created: true };
}

async function findListing(client, sellerId, title) {
  const { rows } = await client.query(
    'SELECT id FROM listings WHERE seller_id = $1 AND title = $2',
    [sellerId, title],
  );
  return rows[0] ? rows[0].id : null;
}

async function insertListing(client, { sellerId, categoryId, title, desc, cond, ai, start, hours, status, photos, slug }) {
  const { rows } = await client.query(
    `INSERT INTO listings (seller_id, category_id, title, description, condition,
                           ai_suggested_price, starting_price, duration_hours, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - interval '1 day')
     RETURNING id`,
    [sellerId, categoryId, title, desc || null, cond || null, ai || null, start, hours, status],
  );
  const listingId = rows[0].id;
  for (let i = 0; i < photos; i += 1) {
    await client.query(
      'INSERT INTO listing_photos (listing_id, url, order_index) VALUES ($1, $2, $3)',
      [listingId, photo(slug, i + 1), i],
    );
  }
  return listingId;
}

const slugOf = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);

// Tạo một phiên đã kết thúc có người thắng, và đơn hàng ở đúng giai đoạn kho.
async function seedSoldItem(client, ctx, item) {
  const sellerId = ctx.accounts[item.seller];
  const winnerId = ctx.accounts[item.winner];
  const loserId = ctx.accounts[item.loser];
  const now = Date.now();
  const endedAt = new Date(now - item.endedAgo);
  const hours = 72;

  const listingId = await insertListing(client, {
    sellerId, categoryId: ctx.cats[item.cat], title: item.title, desc: `${item.title}. Hàng đã qua thẩm định BidVibe.`,
    cond: 'Đã qua sử dụng', ai: item.start, start: item.start, hours, status: 'pending_appraisal',
    photos: 2, slug: slugOf(item.title),
  });
  await client.query(
    `INSERT INTO appraisals (listing_id, appraiser_id, decision, reason, decided_at)
     VALUES ($1, $2, 'approve', NULL, $3)`,
    [listingId, ctx.ops['ngoc.le@bidvibe.vn'], new Date(endedAt.getTime() - (hours + 2) * HOUR)],
  );

  // Phiên do BE1 sinh (createAuctionForListing), bắt đầu sao cho kết thúc đúng lúc endedAt.
  const auctionId = await createAuctionForListing(client, listingId, {
    startsAt: new Date(endedAt.getTime() - hours * HOUR),
  });
  const { rows: [auction] } = await client.query(
    'SELECT deposit_required, bid_step FROM auctions WHERE id = $1', [auctionId],
  );
  const deposit = Number(auction.deposit_required);
  const step = Number(auction.bid_step);

  // Hai người cọc tham gia (qua ví BE1), luân phiên đặt giá, người thắng đặt cuối.
  for (const bidderId of [loserId, winnerId]) {
    await client.query(
      'INSERT INTO auction_deposits (auction_id, bidder_id, amount, created_at) VALUES ($1, $2, $3, $4)',
      [auctionId, bidderId, deposit, new Date(endedAt.getTime() - 48 * HOUR)],
    );
    await walletService.holdDeposit(client, { bidderId, auctionId, amount: deposit });
  }
  const bids = [];
  for (let p = item.start + step; p < item.price; p += step * 4) bids.push(p);
  bids.push(item.price);
  // người thắng phải là người đặt cuối: đi ngược từ cuối, xen kẽ thắng/thua
  const bidRows = bids.map((amount, i) => ({
    amount,
    bidderId: (bids.length - 1 - i) % 2 === 0 ? winnerId : loserId,
    at: new Date(endedAt.getTime() - (bids.length - i) * 37 * 60_000),
  }));
  for (const b of bidRows) {
    await client.query(
      'INSERT INTO bids (auction_id, bidder_id, amount, created_at) VALUES ($1, $2, $3, $4)',
      [auctionId, b.bidderId, b.amount, b.at],
    );
  }
  await client.query(
    `UPDATE auctions SET status = 'ended', winner_id = $2, current_price = $3, bid_count = $4 WHERE id = $1`,
    [auctionId, winnerId, item.price, bidRows.length],
  );
  await client.query(`UPDATE listings SET status = 'ended' WHERE id = $1`, [listingId]);

  // Cọc: người thua được hoàn, người thắng trừ vào thanh toán.
  await client.query(
    `UPDATE auction_deposits SET status = 'released' WHERE auction_id = $1 AND bidder_id = $2`,
    [auctionId, loserId],
  );
  await walletService.releaseDeposit(client, { bidderId: loserId, auctionId, amount: deposit });
  await client.query(
    `UPDATE auction_deposits SET status = 'applied_to_payment' WHERE auction_id = $1 AND bidder_id = $2`,
    [auctionId, winnerId],
  );

  const paymentDeadline = new Date(endedAt.getTime() + DAY);
  const { rows: [order] } = await client.query(
    `INSERT INTO orders (auction_id, bidder_id, seller_id, final_price, payment_deadline, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [auctionId, winnerId, sellerId, item.price, paymentDeadline, endedAt],
  );
  const orderId = order.id;
  const totalDue = totalDueFor(item.price);

  if (item.stage === 'awaiting_payment') {
    await createNotification(client, {
      accountId: winnerId, type: 'win',
      title: `Bạn đã thắng phiên · ${item.title}. Thanh toán trong 24 giờ.`,
    });
    return { orderId, totalDue };
  }

  // Thanh toán qua cổng ngoài (VietQR, giả lập) -> cọc được trừ, tiền vào ký quỹ nền tảng.
  await walletService.payOrder(client, {
    bidderId: winnerId, auctionId, totalDue, depositAmount: deposit, viaWallet: false,
  });
  await client.query(`UPDATE orders SET payment_status = 'paid' WHERE id = $1`, [orderId]);

  await seedWarehouse(client, ctx, item, { orderId, winnerId, endedAt });
  return { orderId, totalDue };
}

const STAGE_ORDER = ['waiting', 'inspecting', 'inspecting_done', 'packed', 'shipped', 'delivered', 'completed'];
const reached = (stage, target) => STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(target);

async function seedWarehouse(client, ctx, item, { orderId, winnerId, endedAt }) {
  const { stage } = item;
  if (stage === 'waiting') return; // đã thanh toán, chờ người bán gửi hàng tới kho

  const inspector = ctx.ops['anh.pham@bidvibe.vn'];
  const receivedAt = new Date(endedAt.getTime() + 2 * DAY);

  if (stage === 'escalated') {
    await client.query(
      `INSERT INTO warehouse_receipts (order_id, order_code, inspected_by, inspection_result, inspection_notes, received_at)
       VALUES ($1, $2, $3, 'mismatch', $4, $5)`,
      [orderId, item.code, inspector, item.mismatch, receivedAt],
    );
    await client.query(`UPDATE orders SET payout_status = 'disputed' WHERE id = $1`, [orderId]);
    const { rows: [d] } = await client.query(
      `INSERT INTO disputes (order_id, source, reporter_id, title, status, escrow_amount)
       VALUES ($1, 'warehouse', NULL, $2, 'open', $3) RETURNING id`,
      [orderId, `${item.title} — thiếu hàng so với mô tả`, totalDueFor(item.price)],
    );
    await addTimeline(client, d.id, [
      [receivedAt, `Kho phát hiện sai lệch khi đối chiếu: ${item.mismatch}`],
      [new Date(receivedAt.getTime() + HOUR), 'Kho tạm giữ hàng, báo cáo lên Admin.'],
    ]);
    return;
  }

  const inspected = reached(stage, 'inspecting_done');
  await client.query(
    `INSERT INTO warehouse_receipts (order_id, order_code, inspected_by, inspection_result, inspection_notes, received_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, item.code, inspected ? inspector : null, inspected ? 'match' : null,
      inspected ? `Kiểm hàng đạt · ${item.grade} · ${item.shelf}` : null, receivedAt],
  );
  if (!reached(stage, 'packed')) return;

  const shipmentStatus = reached(stage, 'delivered') ? 'delivered' : reached(stage, 'shipped') ? 'shipped' : 'packing';
  const deliveredAt = item.deliveredAgo ? new Date(Date.now() - item.deliveredAgo) : null;
  const { rows: [s] } = await client.query(
    `INSERT INTO shipments (order_id, status, tracking_code, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orderId, shipmentStatus, item.tracking || null, deliveredAt || new Date(receivedAt.getTime() + DAY)],
  );
  const events = [[new Date(receivedAt.getTime() + 12 * HOUR), 'packing', `Đóng gói tại ${item.shelf}`]];
  if (reached(stage, 'shipped')) {
    events.push([new Date(receivedAt.getTime() + DAY), 'shipped', `Bàn giao ${item.carrier} · mã vận đơn ${item.tracking}`]);
  }
  if (reached(stage, 'delivered')) {
    events.push([deliveredAt, 'delivered', 'Giao hàng thành công']);
  }
  for (const [at, step, note] of events) {
    await client.query(
      'INSERT INTO shipment_events (shipment_id, step, note, at) VALUES ($1, $2, $3, $4)',
      [s.id, step, note, at],
    );
  }
  if (!reached(stage, 'delivered')) return;

  // Đã giao: hạn tự giải ngân = lúc giao + 72 giờ.
  const payoutDeadline = new Date(deliveredAt.getTime() + 72 * HOUR);
  await client.query('UPDATE orders SET payout_deadline = $2 WHERE id = $1', [orderId, payoutDeadline]);

  if (stage === 'completed') {
    // Quyết định mặc định: giải ngân Seller chỉ đổi payout_status (chưa có ví Seller).
    await client.query(
      `UPDATE orders SET delivered_confirmed_at = $2, payout_status = 'released' WHERE id = $1`,
      [orderId, new Date(deliveredAt.getTime() + 6 * HOUR)],
    );
    if (item.resolvedDispute) {
      const { rows: [d] } = await client.query(
        `INSERT INTO disputes (order_id, source, reporter_id, title, status, escrow_amount, resolution, resolved_by)
         VALUES ($1, 'bidder', $2, $3, 'resolved', 0, 'keep', $4) RETURNING id`,
        [orderId, winnerId, `${item.title} — giao hàng chậm`, ctx.ops['trang.dang@bidvibe.vn']],
      );
      await addTimeline(client, d.id, [
        [new Date(deliveredAt.getTime() - DAY), 'Người mua mở tranh chấp: giao hàng chậm hơn dự kiến 3 ngày.'],
        [new Date(deliveredAt.getTime() + 2 * HOUR), 'Admin xác minh hàng đã giao đúng mô tả, giữ nguyên giao dịch.'],
      ]);
    } else {
      await createNotification(client, {
        accountId: winnerId, type: 'info', title: `Đơn hàng hoàn tất · ${item.title}`,
      });
    }
    return;
  }

  // delivered, chờ người mua xác nhận
  if (item.disputedByBidder) {
    await client.query(`UPDATE orders SET payout_status = 'disputed' WHERE id = $1`, [orderId]);
    const { rows: [d] } = await client.query(
      `INSERT INTO disputes (order_id, source, reporter_id, title, status, escrow_amount)
       VALUES ($1, 'bidder', $2, $3, 'open', $4) RETURNING id`,
      [orderId, winnerId, `${item.title} — hàng nhận không đúng mô tả`, totalDueFor(item.price)],
    );
    await addTimeline(client, d.id, [
      [new Date(deliveredAt.getTime() + 3 * HOUR), 'Người mua mở tranh chấp: ống kính có nấm, mô tả ghi "không nấm".'],
      [new Date(deliveredAt.getTime() + 3 * HOUR), 'Khoản ký quỹ được giữ lại cho tới khi Admin phán quyết.'],
    ]);
  } else {
    await createNotification(client, {
      accountId: winnerId, type: 'order',
      title: `Đơn hàng đã giao · ${item.title}. Hãy kiểm tra và xác nhận đã nhận hàng.`,
    });
  }
}

async function addTimeline(client, disputeId, entries) {
  for (const [at, note] of entries) {
    await client.query(
      'INSERT INTO dispute_timeline (dispute_id, note, at) VALUES ($1, $2, $3)',
      [disputeId, note, at],
    );
  }
}

// ---------- Main ----------

async function main() {
  const stats = {
    accounts: 0, ops: 0, pipeline: 0, sold: 0, flags: 0, approvals: 0, sellerDisputes: 0, skipped: [],
  };

  await inTransaction(async (client) => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ctx = { accounts: {}, ops: {}, cats: {} };

    for (const [fullName, email, phone] of BIDDERS) {
      const r = await ensureAccount(client, hash, { fullName, email, phone, role: 'bidder' });
      if (r.created) {
        stats.accounts += 1;
        await walletService.topUp(client, { bidderId: r.id, amount: 20_000_000 });
      }
      ctx.accounts[email] = r.id;
    }
    for (const [fullName, email, phone, shop, rating] of SELLERS) {
      const r = await ensureAccount(client, hash, { fullName, email, phone, role: 'seller', shop, rating });
      if (r.created) stats.accounts += 1;
      ctx.accounts[email] = r.id;
    }
    for (const [name, email, role, status, load] of OPS) {
      const ins = await client.query(
        `INSERT INTO ops_accounts (name, email, role, status, weekly_load, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (email) DO NOTHING RETURNING id`,
        [name, email, role, status, load, hash],
      );
      if (ins.rows[0]) stats.ops += 1;
      // Tài khoản ops tạo trước migration 003 có thể chưa có mật khẩu.
      await client.query(
        'UPDATE ops_accounts SET password_hash = $2 WHERE lower(email) = $1 AND password_hash IS NULL',
        [email, hash],
      );
      const { rows } = await client.query('SELECT id FROM ops_accounts WHERE lower(email) = $1', [email]);
      ctx.ops[email] = rows[0].id;
    }
    const cats = await client.query('SELECT code, id FROM categories');
    for (const r of cats.rows) ctx.cats[r.code] = r.id;

    // Tin đăng trong quy trình thẩm định.
    for (const l of PIPELINE_LISTINGS) {
      const sellerId = ctx.accounts[l.seller];
      if (await findListing(client, sellerId, l.title)) continue;
      const listingId = await insertListing(client, {
        sellerId, categoryId: ctx.cats[l.cat], title: l.title, desc: l.desc, cond: l.cond, ai: l.ai,
        start: l.start, hours: 72, status: l.status, photos: l.photos, slug: slugOf(l.title),
      });
      if (l.appraisal) {
        await client.query(
          `INSERT INTO appraisals (listing_id, appraiser_id, decision, reason) VALUES ($1, $2, $3, $4)`,
          [listingId, ctx.ops[l.appraisal.by], l.appraisal.decision, l.appraisal.reason],
        );
      }
      stats.pipeline += 1;
    }

    // Lịch sử duyệt cho các phiên đang diễn ra (do seed BE1 tạo, chưa có dòng appraisals).
    const live = await client.query(
      `SELECT l.id FROM listings l
       WHERE l.status = 'live' AND NOT EXISTS (SELECT 1 FROM appraisals ap WHERE ap.listing_id = l.id)`,
    );
    for (const { id } of live.rows) {
      await client.query(
        `INSERT INTO appraisals (listing_id, appraiser_id, decision, decided_at)
         VALUES ($1, $2, 'approve', now() - interval '3 days')`,
        [id, ctx.ops['ngoc.le@bidvibe.vn']],
      );
      stats.approvals += 1;
    }

    // Phiên đã kết thúc + đơn hàng ở mọi trạng thái kho.
    for (const item of SOLD) {
      if (await findListing(client, ctx.accounts[item.seller], item.title)) continue;
      const { orderId, totalDue } = await seedSoldItem(client, ctx, item);
      if (item.disputedBySeller) {
        const { rows: [d] } = await client.query(
          `INSERT INTO disputes (order_id, source, reporter_id, title, status, escrow_amount)
           VALUES ($1, 'seller', $2, $3, 'open', $4) RETURNING id`,
          [orderId, ctx.accounts[item.seller], `${item.title} — người mua đòi huỷ sau khi thanh toán`, totalDue],
        );
        await addTimeline(client, d.id, [
          [new Date(Date.now() - 20 * HOUR), 'Người bán mở tranh chấp: người mua yêu cầu huỷ đơn sau khi đã thanh toán.'],
          [new Date(Date.now() - 20 * HOUR), 'Khoản ký quỹ được giữ lại cho tới khi Admin phán quyết.'],
        ]);
        await client.query(`UPDATE orders SET payout_status = 'disputed' WHERE id = $1`, [orderId]);
        stats.sellerDisputes += 1;
      }
      stats.sold += 1;
    }

    // Cờ AI trên các phiên đang diễn ra.
    for (const f of FLAGS) {
      const { rows } = await client.query(
        `SELECT a.id FROM auctions a JOIN listings l ON l.id = a.listing_id
         WHERE l.title = $1 AND a.status = 'active' ORDER BY a.id LIMIT 1`,
        [f.title],
      );
      if (!rows[0]) { stats.skipped.push(`cờ "${f.reason}" (chưa có phiên "${f.title}" — chạy seed_demo trước)`); continue; }
      const auctionId = rows[0].id;
      const exists = await client.query(
        'SELECT 1 FROM flagged_auctions WHERE auction_id = $1 AND reason = $2', [auctionId, f.reason],
      );
      if (exists.rows[0]) continue;
      const { rows: [flag] } = await client.query(
        `INSERT INTO flagged_auctions (auction_id, severity, confidence, reason, ai_explanation, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [auctionId, f.severity, f.confidence, f.reason, f.explain, f.status],
      );
      for (const [label, value] of f.evidence) {
        await client.query(
          'INSERT INTO flag_evidence (flagged_auction_id, label, value) VALUES ($1, $2, $3)',
          [flag.id, label, value],
        );
      }
      stats.flags += 1;
    }
  });

  console.log('Seed BE2 xong (chỉ thêm phần còn thiếu):');
  console.log(`  tài khoản mới: ${stats.accounts}, tài khoản nội bộ mới: ${stats.ops}`);
  console.log(`  tin đăng chờ thẩm định/bổ sung/từ chối/nháp: ${stats.pipeline}`);
  console.log(`  lịch sử duyệt thêm cho phiên đang diễn ra: ${stats.approvals}`);
  console.log(`  phiên đã bán + đơn hàng: ${stats.sold} (tranh chấp từ người bán: ${stats.sellerDisputes})`);
  console.log(`  cờ AI: ${stats.flags}`);
  stats.skipped.forEach((s) => console.log(`  bỏ qua: ${s}`));
  console.log(`Mật khẩu demo mọi tài khoản: ${PASSWORD}. Ops đăng nhập qua POST /api/auth/ops/login.`);
}

main()
  .catch((err) => { console.error('Seed lỗi:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
