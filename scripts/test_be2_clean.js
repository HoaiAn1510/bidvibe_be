// Dọn dữ liệu test BE2 trên database dùng chung.
//   npm run test:clean              in danh sách rồi xoá dữ liệu test_be2_ bỏ sót, cũ hơn 1 giờ
//   npm run test:clean -- --dry-run chỉ in danh sách, không xoá
//
// Dữ liệu test BE2 luôn đi ra từ tài khoản có email test_be2_<mã lần chạy>_<tên>@example.com
// (mã lần chạy = thời điểm bắt đầu dạng base36 + 3 ký tự ngẫu nhiên). Lệnh này chỉ xoá các tài
// khoản mà lần chạy bắt đầu từ hơn 1 giờ trước (lâu hơn nhiều so với một lần chạy test), nên không
// đụng tới lần chạy đang diễn ra của người khác. Email kiểu cũ test_be2_<mili giây>_ cũng được nhận.
// test_be2.js dùng chung hàm purge() để dọn đúng dữ liệu của chính lần chạy đó.
const { pool } = require('../src/config/db');

const PREFIX = 'test_be2_';
const DOMAIN = '@example.com';
const STALE_MS = 60 * 60_000;
// LIKE: dấu _ là ký tự đại diện nên phải escape để chỉ khớp đúng tiền tố.
const like = (p) => p.replace(/_/g, '\\_');

// Thời điểm bắt đầu của lần chạy đã tạo email; null nếu email không chứa mã lần chạy
// (ví dụ test_be2_curl_ trong docs/fe-quickstart.md).
function runStartOf(email) {
  const legacy = /^test_be2_(\d{13})_/.exec(email);
  if (legacy) return Number(legacy[1]);
  const m = /^test_be2_([0-9a-z]{9,})_/.exec(email);
  return m ? parseInt(m[1].slice(0, -3), 36) : null;
}

// Tài khoản (thường và nội bộ) có email bắt đầu bằng `prefix` (mặc định: mọi test_be2_).
async function findAccounts(prefix = PREFIX) {
  const pattern = `${like(prefix)}%${like(DOMAIN)}`;
  const acc = (await pool.query('SELECT id, email, created_at FROM accounts WHERE email LIKE $1 ORDER BY id', [pattern])).rows;
  const ops = (await pool.query('SELECT id, email FROM ops_accounts WHERE email LIKE $1 ORDER BY id', [pattern])).rows;
  return { acc, ops };
}

// Xoá mọi dòng đi ra từ các tài khoản này. Không điều kiện nào khớp được dữ liệu của tài khoản khác.
async function purge(accIds, opsIds) {
  if (accIds.length) {
    const run = (sql) => pool.query(sql, [accIds]);
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
  }
  if (opsIds.length) await pool.query('DELETE FROM ops_accounts WHERE id = ANY($1)', [opsIds]);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { acc, ops } = await findAccounts();
  const now = Date.now();
  // Email không có mã: tài khoản thường tính theo created_at; ops_accounts không có cột này nên
  // coi như cũ (chỉ script test tạo tài khoản nội bộ test_be2_, và luôn kèm mã).
  const startOf = (r) => runStartOf(r.email) ?? (r.created_at ? r.created_at.getTime() : 0);
  const stale = (r) => now - startOf(r) > STALE_MS;
  const oldAcc = acc.filter(stale);
  const oldOps = ops.filter(stale);
  const skipped = acc.length + ops.length - oldAcc.length - oldOps.length;

  console.log(`Dữ liệu test BE2 cũ hơn ${STALE_MS / 60_000} phút: ${oldAcc.length} tài khoản, ${oldOps.length} tài khoản nội bộ.`);
  for (const r of oldAcc) console.log(`  account ${r.id}  ${r.email}`);
  for (const r of oldOps) console.log(`  ops     ${r.id}  ${r.email}`);
  if (skipped) console.log(`Bỏ qua ${skipped} tài khoản của lần chạy chưa quá ${STALE_MS / 60_000} phút (có thể đang chạy).`);
  if (dryRun) { console.log('--dry-run: không xoá gì.'); return; }
  if (!oldAcc.length && !oldOps.length) { console.log('Không có gì để xoá.'); return; }
  await purge(oldAcc.map((r) => r.id), oldOps.map((r) => r.id));
  console.log('Đã xoá xong (kèm phiên, tin đăng, đơn, giao dịch ví, thông báo của các tài khoản trên).');
}

if (require.main === module) {
  main()
    .catch((err) => { console.error('LỖI:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { PREFIX, DOMAIN, like, findAccounts, purge };
