// Đối soát ví — CHỈ ĐỌC (một giao dịch READ ONLY, REPEATABLE READ nên mọi truy vấn thấy cùng một ảnh chụp dữ liệu).
//
//   npm run wallet:check                       đối soát mọi ví
//   npm run wallet:check -- --bidder-ids=1,2   chỉ các ví này
//
// Có ví lệch thì in bảng và thoát với mã 1, không thì thoát mã 0. Không sửa gì trong database.
//
// CÔNG THỨC ĐỐI SOÁT (đọc từ src/services/wallet_service.js; mỗi giao dịch ví ghi `amount` và `balance_after` = số dư
// SAU giao dịch, nên số dư dựng lại được bằng cách đi dọc sổ giao dịch của từng người theo thứ tự `id`):
//
//   Loại giao dịch     balance                    held                      Ghi chú
//   topup              + amount                   -
//   deposit_hold       - amount                   + amount                  giữ cọc
//   deposit_release    + amount                   - amount                  hoàn cọc (thua phiên / phiên bị huỷ)
//   deposit_forfeit    -                          - amount                  tịch thu cọc (quá hạn thanh toán)
//   payment            - max(amount - cọc, 0)     - cọc                     `amount` = tổng phải trả; trừ ví khi
//                      hoặc 0 (VietQR / thẻ)                                  thanh toán bằng ví, cọc = auction_deposits.amount
//   refund             + amount                   -
//
// Bốn kiểm tra cho mỗi ví:
//   1. balance_chain  mỗi giao dịch: balance_after - balance_after của giao dịch liền trước (người đó; giao dịch đầu: 0)
//                     phải đúng bảng trên (payment: bằng 0 hoặc -(amount - cọc)).
//   2. balance        bidders.wallet_balance = balance_after của giao dịch cuối (ví chưa có giao dịch: 0).
//   3. held_ledger    bidders.wallet_held = Σ deposit_hold - Σ deposit_release - Σ deposit_forfeit - Σ cọc đã trừ ở payment.
//   4. held_deposits  bidders.wallet_held = Σ auction_deposits đang giữ tiền, gồm: status 'held' VÀ status
//                     'applied_to_payment' mà đơn còn 'awaiting_payment' (người thắng đã bị trừ cọc vào đơn nhưng chưa
//                     thanh toán nên tiền vẫn nằm trong held; thanh toán xong thì held giảm, cọc vẫn 'applied_to_payment').
//
// Lưu ý: số dư và giao dịch đổi liên tục khi hệ thống đang chạy; ảnh chụp REPEATABLE READ chỉ nhất quán trong lúc đọc.
const { pool } = require('../src/config/db');

// payment: cọc đã trừ vào đơn = auction_deposits.amount của chính người đó ở phiên đó.
const DEP_OF_TX = `COALESCE((SELECT d.amount FROM auction_deposits d
                              WHERE d.auction_id = w.related_auction_id AND d.bidder_id = w.bidder_id), 0)`;

const FILTER = 'w.bidder_id = ANY($1::bigint[])';

async function checkWallets({ bidderIds = null } = {}) {
  const ids = bidderIds && bidderIds.length ? bidderIds.map(String) : null;
  const client = await pool.connect();
  const problems = [];
  let wallets = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const walletRows = (await client.query(
      `SELECT account_id AS id, wallet_balance::bigint AS balance, wallet_held::bigint AS held FROM bidders
       ${ids ? 'WHERE account_id = ANY($1::bigint[])' : ''} ORDER BY account_id`, ids ? [ids] : [])).rows;
    wallets = walletRows.length;
    if (wallets === 0) {
      await client.query('COMMIT');
      return { wallets, problems };
    }
    const scope = walletRows.map((r) => String(r.id));
    const add = (bidderId, check, detail, actual, expected) => problems.push({
      bidderId: String(bidderId), check, detail, actual: String(actual), expected: String(expected), diff: String(Number(actual) - Number(expected)),
    });

    // 0. Số dư / tiền giữ không âm
    for (const w of walletRows) {
      if (Number(w.balance) < 0) add(w.id, 'negative', 'wallet_balance âm', w.balance, 0);
      if (Number(w.held) < 0) add(w.id, 'negative', 'wallet_held âm', w.held, 0);
    }

    // 1. Chuỗi số dư theo từng giao dịch (cửa sổ LAG trên toàn bộ giao dịch của người đó)
    const chain = await client.query(
      `WITH t AS (
         SELECT w.id, w.bidder_id, w.kind, w.amount, w.balance_after,
                w.balance_after - COALESCE(LAG(w.balance_after) OVER (PARTITION BY w.bidder_id ORDER BY w.id), 0) AS delta,
                ${DEP_OF_TX} AS dep
         FROM wallet_transactions w WHERE ${FILTER}
       )
       SELECT id, bidder_id, kind, amount, delta, dep FROM t
       WHERE NOT (
         (kind IN ('topup', 'deposit_release', 'refund') AND delta = amount)
         OR (kind = 'deposit_hold' AND delta = -amount)
         OR (kind = 'deposit_forfeit' AND delta = 0)
         OR (kind = 'payment' AND (delta = 0 OR delta = -GREATEST(amount - dep, 0)))
       ) ORDER BY id`, [scope]);
    for (const r of chain.rows) {
      const expected = { topup: r.amount, deposit_release: r.amount, refund: r.amount, deposit_hold: -r.amount, deposit_forfeit: 0 }[r.kind];
      add(r.bidder_id, 'balance_chain', `giao dịch #${r.id} (${r.kind}, amount ${r.amount}${r.kind === 'payment' ? `, cọc ${r.dep}` : ''})`,
        r.delta, expected === undefined ? `0 hoặc ${-Math.max(Number(r.amount) - Number(r.dep), 0)}` : expected);
    }

    // 2. Số dư hiện tại = balance_after của giao dịch cuối
    const last = await client.query(
      `SELECT DISTINCT ON (w.bidder_id) w.bidder_id, w.id, w.balance_after FROM wallet_transactions w WHERE ${FILTER}
       ORDER BY w.bidder_id, w.id DESC`, [scope]);
    const lastOf = new Map(last.rows.map((r) => [String(r.bidder_id), r]));
    for (const w of walletRows) {
      const l = lastOf.get(String(w.id));
      const expected = l ? l.balance_after : 0;
      if (String(w.balance) !== String(expected)) {
        add(w.id, 'balance', l ? `wallet_balance khác balance_after của giao dịch cuối #${l.id}` : 'ví chưa có giao dịch nhưng wallet_balance khác 0', w.balance, expected);
      }
    }

    // 3. Tiền đang giữ theo sổ giao dịch
    const ledgerHeld = await client.query(
      `SELECT w.bidder_id,
              SUM(CASE w.kind WHEN 'deposit_hold' THEN w.amount
                              WHEN 'deposit_release' THEN -w.amount
                              WHEN 'deposit_forfeit' THEN -w.amount
                              WHEN 'payment' THEN -${DEP_OF_TX}
                              ELSE 0 END)::bigint AS held
       FROM wallet_transactions w WHERE ${FILTER} GROUP BY w.bidder_id`, [scope]);
    const ledgerOf = new Map(ledgerHeld.rows.map((r) => [String(r.bidder_id), r.held]));
    for (const w of walletRows) {
      const expected = ledgerOf.get(String(w.id)) ?? 0;
      if (String(w.held) !== String(expected)) add(w.id, 'held_ledger', 'wallet_held khác tiền giữ suy ra từ sổ giao dịch', w.held, expected);
    }

    // 4. Tiền đang giữ theo các khoản cọc
    const depHeld = await client.query(
      `SELECT d.bidder_id, SUM(d.amount)::bigint AS held
       FROM auction_deposits d
       WHERE d.bidder_id = ANY($1::bigint[])
         AND (d.status = 'held'
              OR (d.status = 'applied_to_payment' AND EXISTS (
                    SELECT 1 FROM orders o
                    WHERE o.auction_id = d.auction_id AND o.bidder_id = d.bidder_id AND o.payment_status = 'awaiting_payment')))
       GROUP BY d.bidder_id`, [scope]);
    const depOf = new Map(depHeld.rows.map((r) => [String(r.bidder_id), r.held]));
    for (const w of walletRows) {
      const expected = depOf.get(String(w.id)) ?? 0;
      if (String(w.held) !== String(expected)) add(w.id, 'held_deposits', "wallet_held khác tổng cọc đang giữ ('held' + 'applied_to_payment' chưa thanh toán)", w.held, expected);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { wallets, problems };
}

function parseArgs(argv) {
  const out = { bidderIds: null };
  for (const a of argv) {
    const m = /^--bidder-ids=(.*)$/.exec(a);
    if (!m) throw new Error(`Tham số không hợp lệ: ${a}. Dùng: npm run wallet:check [-- --bidder-ids=1,2,3]`);
    const list = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.length || list.some((x) => !/^\d{1,18}$/.test(x))) throw new Error('--bidder-ids phải là danh sách id số, ngăn cách bằng dấu phẩy');
    out.bidderIds = list;
  }
  return out;
}

async function main() {
  const { bidderIds } = parseArgs(process.argv.slice(2));
  const { wallets, problems } = await checkWallets({ bidderIds });
  const bad = new Set(problems.map((p) => p.bidderId));
  if (problems.length) {
    console.table(problems.map((p) => ({
      'Ví (bidder)': p.bidderId, 'Kiểm tra': p.check, 'Chi tiết': p.detail, 'Thực tế': p.actual, 'Kỳ vọng': p.expected, 'Chênh': p.diff,
    })));
  }
  console.log(`Đối soát ${wallets} ví: ${wallets - bad.size} khớp, ${bad.size} lệch (${problems.length} mục).`);
  if (problems.length) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((err) => { console.error('wallet:check lỗi:', err.message); process.exitCode = 2; })
    .finally(() => pool.end());
}

module.exports = { checkWallets, parseArgs };
