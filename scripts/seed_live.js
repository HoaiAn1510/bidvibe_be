// Làm mới dữ liệu demo trước buổi demo: bảo đảm có 9 phiên demo ĐANG DIỄN RA (đủ 3 danh mục,
// giá và bước giá khác nhau, giờ kết thúc từ ~3 phút tới 2 ngày).
//
//   npm run db:seed:live               tạo bù phiên demo đang thiếu (đủ rồi thì không làm gì)
//   npm run db:seed:live -- --extend   như trên, và đẩy giờ kết thúc các phiên demo đang chạy ra xa
//
// - "Phiên demo" = tin đăng của một Seller demo (seed_demo.js) có tiêu đề nằm trong bộ mẫu LIVE bên
//   dưới. Mỗi mẫu có tối đa một phiên đang chạy; chạy lại chỉ tạo phiên cho mẫu đang thiếu.
// - Đi đúng đường phiên thật: tin đăng 'pending_appraisal' kèm ảnh -> Thẩm định viên demo duyệt
//   (dòng appraisals 'approve') -> createAuctionForListing (BE1) sinh auctions, tin -> 'live'.
//   Riêng mẫu "~3 phút" (thử chống chốt phút chót) đặt lại ends_at sau khi tạo.
// - Không sửa / xoá phiên đã kết thúc, đơn, cọc hay giao dịch có sẵn. --extend chỉ đổi ends_at của
//   phiên demo đang chạy (không đang tạm dừng): ends_at = max(ends_at, bây giờ + thời lượng mẫu).
// - Từ chối chạy khi NODE_ENV=production. Cần chạy `npm run db:seed` trước (tạo Seller / Thẩm định viên).
// - Cũng tạo 3 tài khoản bot đấu giá (bot1..3@bidvibe.demo) nếu chưa có.
//
// Ảnh: Wikimedia Commons, giấy phép tự do, dùng trực tiếp qua thumb.wikimedia.org; ảnh đầu là ảnh bìa.
// Trang gốc: https://commons.wikimedia.org/wiki/File:<tên file>
//   Nike Air Jordan IV.jpg, V.jpg, VIII.jpg, XII.jpg — Osyffar, CC0
//   Mizuno Wave Ibuki 2.jpg — Petar Milošević, CC BY-SA 4.0; Brooks Ghost 14 GTX.jpg — Petar Milošević, CC BY-SA 4.0
//   Leica M6 TTL front.jpg, back.jpg — Sodacan, CC BY-SA 4.0
//   Leica-md-17 hg.jpg, Leica-md-18 hg.jpg — Hannes Grobe, CC BY-SA 4.0
//   Sennheiser HD800S.jpg, Sennheiser HD800S (alternate view).jpg — Benlisquare, CC BY-SA 4.0
//   Vintage Seiko Automatic (Self-Winding) Men's Goldtone Watch (9936256593).jpg,
//   Vintage Seiko Men's Automatic-Wind Wrist Watch, 17 Jewels, Made in Japan (8502825813).jpg — Joe Haupt, CC BY-SA 2.0
//   Elephant figurine, Bat Trang kiln ... DSC05427.JPG; Tiger figurine, Bat Trang kiln ... DSC05418.JPG — Daderot, CC0
//   Ornamental jar ... Nguyen dynasty ... DSC05320.JPG; Wine vase ... Nguyen dynasty ... DSC05323.JPG — Daderot, CC0
const { pool } = require('../src/config/db');
const engine = require('../src/services/auction_engine');
const { ensureBotAccounts } = require('./demo_bots');

const WM = 'https://thumb.wikimedia.org/wikipedia/commons/thumb';
const MIN = 60_000;
const H = 60 * MIN;

// sellerEmail: Seller demo của seed_demo.js. endsInMs: thời lượng từ lúc tạo (hoặc --extend).
const LIVE = [
  {
    sellerEmail: 'long@sneakersg.vn', cat: 'shoes', endsInMs: 3 * MIN,
    title: 'Lô 2 đôi bóng rổ retro Jordan IV và Jordan V, size 43',
    cond: 'Đã qua sử dụng nhẹ, đế còn tốt',
    desc: 'Một đôi Jordan IV trắng xám và một đôi Jordan V trắng tím. Da còn mềm, không rách, đế chưa mòn. Bán theo lô 2 đôi.',
    start: 4_500_000, step: 100_000,
    photos: [`${WM}/a/a5/Nike_Air_Jordan_IV.jpg/960px-Nike_Air_Jordan_IV.jpg`, `${WM}/a/a9/Nike_Air_Jordan_V.jpg/960px-Nike_Air_Jordan_V.jpg`],
  },
  {
    sellerEmail: 'hai@retrocamera.vn', cat: 'elec', endsInMs: 2 * H,
    title: 'Máy ảnh Leica M6 TTL màu đen, chỉ thân máy',
    cond: 'Hoạt động tốt, đo sáng chuẩn',
    desc: 'Thân máy Leica M6 TTL bản đen, khung ngắm sáng, màn trập chạy đều mọi tốc độ. Kèm nắp thân máy, không kèm ống kính.',
    start: 38_000_000, step: 500_000,
    photos: [`${WM}/e/e6/Leica_M6_TTL_front.jpg/960px-Leica_M6_TTL_front.jpg`, `${WM}/f/fb/Leica_M6_TTL_back.jpg/960px-Leica_M6_TTL_back.jpg`],
  },
  {
    sellerEmail: 'ha@phocoxua.vn', cat: 'antique', endsInMs: 4 * H,
    title: 'Bộ 2 tượng gốm men rạn Bát Tràng: voi đội lọ và hổ',
    cond: 'Nguyên vẹn, men rạn tự nhiên',
    desc: 'Hai tượng gốm Bát Tràng men rạn: voi đội lọ hoa vẽ mai và hổ nằm men nâu. Không sứt mẻ, có giấy xác nhận của người bán.',
    start: 12_000_000, step: 200_000,
    photos: [
      `${WM}/f/f3/Elephant_figurine%2C_Bat_Trang_kiln%2C_Hanoi%2C_Restored_Le_dynasty%2C_19th_century_AD%2C_crackle_glazed_ceramic_-_National_Museum_of_Vietnamese_History_-_Hanoi%2C_Vietnam_-_DSC05427.JPG/960px-thumbnail.jpg`,
      `${WM}/8/81/Tiger_figurine%2C_Bat_Trang_kiln%2C_Hanoi%2C_Restored_Le_dynasty%2C_the_Canh_Hung_reign_%281740-1786_AD%29%2C_crackle_and_brown_glazed_ceramic_-_National_Museum_of_Vietnamese_History_-_Hanoi%2C_Vietnam_-_DSC05418.JPG/960px-thumbnail.jpg`,
    ],
  },
  {
    sellerEmail: 'bao@retroaudio.vn', cat: 'elec', endsInMs: 6 * H,
    title: 'Tai nghe Sennheiser HD 800 S, đủ hộp và cáp',
    cond: 'Như mới, ít sử dụng',
    desc: 'Tai nghe mở Sennheiser HD 800 S, đệm tai sạch, cáp 6.35mm nguyên bản. Âm trường rộng, không rè, không lệch kênh.',
    start: 18_000_000, step: 200_000,
    photos: [`${WM}/3/30/Sennheiser_HD800S.jpg/960px-Sennheiser_HD800S.jpg`, `${WM}/4/4e/Sennheiser_HD800S_%28alternate_view%29.jpg/960px-Sennheiser_HD800S_%28alternate_view%29.jpg`],
  },
  {
    sellerEmail: 'long@sneakersg.vn', cat: 'shoes', endsInMs: 10 * H,
    title: 'Lô 2 đôi giày chạy bộ Mizuno và Brooks, size 42',
    cond: 'Mới 90%',
    desc: 'Một đôi Mizuno Wave Ibuki 2 chạy địa hình và một đôi Brooks Ghost 14 GTX chống nước. Đế còn gai, upper sạch.',
    start: 1_800_000, step: 20_000,
    photos: [`${WM}/b/b8/Mizuno_Wave_Ibuki_2.jpg/960px-Mizuno_Wave_Ibuki_2.jpg`, `${WM}/e/e1/Brooks_Ghost_14_GTX.jpg/960px-Brooks_Ghost_14_GTX.jpg`],
  },
  {
    sellerEmail: 'ha@phocoxua.vn', cat: 'antique', endsInMs: 20 * H,
    title: 'Lô 2 đồng hồ Seiko Automatic thập niên 70',
    cond: 'Chạy tốt, mặt số nguyên bản',
    desc: 'Một chiếc Seiko 5 Automatic vỏ mạ vàng và một chiếc Seiko Automatic 17 Jewels dây da. Máy cót tự động, lịch ngày thứ hoạt động.',
    start: 2_600_000, step: 50_000,
    photos: [
      `${WM}/7/71/Vintage_Seiko_Automatic_%28Self-Winding%29_Men%27s_Goldtone_Watch_%289936256593%29.jpg/960px-Vintage_Seiko_Automatic_%28Self-Winding%29_Men%27s_Goldtone_Watch_%289936256593%29.jpg`,
      `${WM}/8/83/Vintage_Seiko_Men%27s_Automatic-Wind_Wrist_Watch%2C_17_Jewels%2C_Made_in_Japan_%288502825813%29.jpg/960px-Vintage_Seiko_Men%27s_Automatic-Wind_Wrist_Watch%2C_17_Jewels%2C_Made_in_Japan_%288502825813%29.jpg`,
    ],
  },
  {
    sellerEmail: 'hai@retrocamera.vn', cat: 'elec', endsInMs: 28 * H,
    title: 'Thân máy Leica MD thập niên 60, màu bạc',
    cond: 'Hoạt động, có vết xước nhẹ',
    desc: 'Thân máy Leica MD (bản không khung ngắm, dùng cho chụp kỹ thuật), vỏ bạc, bọc da đen. Màn trập hoạt động, đã vệ sinh.',
    start: 7_500_000, step: 100_000,
    photos: [`${WM}/d/db/Leica-md-17_hg.jpg/960px-Leica-md-17_hg.jpg`, `${WM}/9/99/Leica-md-18_hg.jpg/960px-Leica-md-18_hg.jpg`],
  },
  {
    sellerEmail: 'long@sneakersg.vn', cat: 'shoes', endsInMs: 36 * H,
    title: 'Lô 2 đôi Jordan VIII và Jordan XII, size 44',
    cond: 'Đã qua sử dụng, còn đẹp',
    desc: 'Một đôi Jordan VIII đen đỏ và một đôi Jordan XII trắng đen. Đế không ố nhiều, dây giày nguyên bản.',
    start: 5_200_000, step: 100_000,
    photos: [`${WM}/f/fb/Nike_Air_Jordan_VIII.jpg/960px-Nike_Air_Jordan_VIII.jpg`, `${WM}/5/58/Nike_Air_Jordan_XII.jpg/960px-Nike_Air_Jordan_XII.jpg`],
  },
  {
    sellerEmail: 'ha@phocoxua.vn', cat: 'antique', endsInMs: 48 * H,
    title: 'Bộ 2 món gốm men rạn thời Nguyễn: chóe có nắp và bình rượu',
    cond: 'Nguyên vẹn, men rạn đều',
    desc: 'Chóe có nắp vẽ lam tích tiên cưỡi phượng và bình rượu đắp nổi cá liễu, men rạn thế kỷ 19. Có giấy xác nhận của người bán.',
    start: 9_000_000, step: 200_000,
    photos: [
      `${WM}/1/19/Ornamental_jar%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05320.JPG/960px-Ornamental_jar%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05320.JPG`,
      `${WM}/9/97/Wine_vase%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05323.JPG/960px-Wine_vase%2C_crackled_glaze_ceramic_-_Nguyen_dynasty%2C_19th_century_AD_-_Vietnam_National_Museum_of_Fine_Arts_-_Hanoi%2C_Vietnam_-_DSC05323.JPG`,
    ],
  },
];
const APPRAISER_EMAIL = 'ngoc.le@bidvibe.vn';

const fmtLeft = (ms) => (ms >= H ? `${Math.round(ms / H)} giờ` : `${Math.max(Math.round(ms / MIN), 0)} phút`);

// Phiên demo của một mẫu đang diễn ra (đang tạm dừng cũng tính là đang diễn ra).
async function activeDemoAuction(client, sellerId, title) {
  const { rows } = await client.query(
    `SELECT a.id, a.ends_at, a.paused_at
     FROM auctions a JOIN listings l ON l.id = a.listing_id
     WHERE l.seller_id = $1 AND l.title = $2 AND a.status = 'active'
       AND (a.ends_at > now() OR a.paused_at IS NOT NULL)
     ORDER BY a.id DESC LIMIT 1`,
    [sellerId, title],
  );
  return rows[0] || null;
}

// Tạo một phiên theo đúng đường của phiên thật. Trả về id phiên.
async function createLive(client, t, { sellerId, categoryId, appraiserId }) {
  const hours = Math.max(Math.ceil(t.endsInMs / H), 1); // duration_hours là số giờ nguyên >= 1
  const { rows: [listing] } = await client.query(
    `INSERT INTO listings (seller_id, category_id, title, description, condition, starting_price, duration_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_appraisal') RETURNING id`,
    [sellerId, categoryId, t.title, t.desc, t.cond, t.start, hours],
  );
  for (let i = 0; i < t.photos.length; i += 1) {
    await client.query('INSERT INTO listing_photos (listing_id, url, order_index) VALUES ($1, $2, $3)', [listing.id, t.photos[i], i]);
  }
  await client.query(
    `INSERT INTO appraisals (listing_id, appraiser_id, decision, reason) VALUES ($1, $2, 'approve', $3)`,
    [listing.id, appraiserId, 'Phiên demo: hàng đúng mô tả'],
  );
  await client.query(`UPDATE listings SET status = 'approved' WHERE id = $1`, [listing.id]);
  const auctionId = await engine.createAuctionForListing(client, listing.id, { bidStep: t.step });
  if (t.endsInMs < hours * H) {
    await client.query(`UPDATE auctions SET ends_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`, [auctionId, String(t.endsInMs)]);
  }
  return auctionId;
}

async function seedLive({ extend = false, log = console.log } = {}) {
  return engine.inTransaction(async (client) => {
    // Hai người chạy cùng lúc thì chạy lần lượt, không tạo trùng.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('bidvibe:seed_live', 0))`);

    const one = async (sql, params, what) => {
      const { rows } = await client.query(sql, params);
      if (!rows[0]) throw new Error(`Thiếu ${what} — chạy \`npm run db:seed\` trước.`);
      return rows[0].id;
    };
    const appraiserId = await one(`SELECT id FROM ops_accounts WHERE email = $1 AND role = 'appraiser'`, [APPRAISER_EMAIL], `Thẩm định viên demo ${APPRAISER_EMAIL}`);
    const cats = Object.fromEntries((await client.query('SELECT code, id FROM categories')).rows.map((r) => [r.code, r.id]));
    const bots = await ensureBotAccounts(client);
    if (bots) log(`  + ${bots} tài khoản bot đấu giá`);

    const result = { created: [], extended: [], kept: [] };
    for (const t of LIVE) {
      const sellerId = await one(
        'SELECT a.id FROM accounts a JOIN sellers s ON s.account_id = a.id WHERE a.email = $1', [t.sellerEmail], `Seller demo ${t.sellerEmail}`,
      );
      const cur = await activeDemoAuction(client, sellerId, t.title);
      if (!cur) {
        const id = await createLive(client, t, { sellerId, categoryId: cats[t.cat], appraiserId });
        result.created.push(id);
        log(`  + #${id} còn ${fmtLeft(t.endsInMs)}: ${t.title}`);
        continue;
      }
      if (extend && !cur.paused_at) {
        const { rows } = await client.query(
          `UPDATE auctions SET ends_at = greatest(ends_at, now() + ($2 || ' milliseconds')::interval)
           WHERE id = $1 AND ends_at < now() + ($2 || ' milliseconds')::interval
           RETURNING ends_at`,
          [cur.id, String(t.endsInMs)],
        );
        if (rows[0]) { result.extended.push(cur.id); log(`  ↻ #${cur.id} gia hạn, còn ${fmtLeft(t.endsInMs)}: ${t.title}`); continue; }
      }
      result.kept.push(cur.id);
    }
    return result;
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Từ chối chạy: NODE_ENV=production. Seed demo chỉ dùng cho môi trường demo.');
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  const bad = args.filter((a) => a !== '--extend');
  if (bad.length) {
    console.error(`Tham số không hợp lệ: ${bad.join(' ')}. Cách dùng: npm run db:seed:live [-- --extend]`);
    process.exitCode = 1;
    return;
  }
  try {
    const r = await seedLive({ extend: args.includes('--extend') });
    console.log(`Xong: tạo ${r.created.length}, gia hạn ${r.extended.length}, giữ nguyên ${r.kept.length} phiên demo đang chạy (bộ mẫu ${LIVE.length} phiên).`);
  } catch (err) {
    console.error('Seed live lỗi:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { LIVE, seedLive };
