// 3 tài khoản người mua CHỈ dùng cho bot đấu giá demo (scripts/demo_bidbot.js).
// Tách khỏi tài khoản demo của người dùng để bot không bao giờ đụng ví / phiên của họ.
// Mật khẩu demo 123456 (chỉ môi trường demo). Dùng chung cho seed_demo.js và seed_live.js.
const bcrypt = require('bcrypt');
const walletService = require('../src/services/wallet_service');

const BOT_PASSWORD = '123456';
const BOT_TOPUP = 50_000_000; // nạp một lần lúc tạo, qua walletService.topUp (có wallet_transactions)
const BOT_ACCOUNTS = [
  { fullName: 'Bot demo 1', email: 'bot1@bidvibe.demo' },
  { fullName: 'Bot demo 2', email: 'bot2@bidvibe.demo' },
  { fullName: 'Bot demo 3', email: 'bot3@bidvibe.demo' },
];
const BOT_EMAILS = BOT_ACCOUNTS.map((b) => b.email);

// Tạo tài khoản bot còn thiếu (idempotent): đã có thì bỏ qua, không đổi số dư.
// `client` đang trong giao dịch của nơi gọi. Trả về số tài khoản vừa tạo.
async function ensureBotAccounts(client) {
  let created = 0;
  for (const { fullName, email } of BOT_ACCOUNTS) {
    const found = await client.query('SELECT id FROM accounts WHERE lower(email) = $1', [email]);
    if (found.rows[0]) continue;
    const hash = await bcrypt.hash(BOT_PASSWORD, 10);
    const { rows } = await client.query(
      'INSERT INTO accounts (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [fullName, email, hash],
    );
    await client.query('INSERT INTO bidders (account_id) VALUES ($1)', [rows[0].id]);
    await walletService.topUp(client, { bidderId: rows[0].id, amount: BOT_TOPUP });
    created += 1;
  }
  return created;
}

module.exports = { BOT_ACCOUNTS, BOT_EMAILS, BOT_PASSWORD, ensureBotAccounts };
