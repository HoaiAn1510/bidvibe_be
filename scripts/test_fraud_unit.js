// Unit test các luật phát hiện gian lận: gọi thẳng analyze() của src/services/fraud_detection.js trên dữ liệu dựng
// sẵn trong bộ nhớ, KHÔNG cần database (require pool nhưng không bao giờ mở kết nối).
//   npm run test:fraud
//
// Mỗi luật có ít nhất một ca phát hiện đúng và một ca KHÔNG được báo nhầm, kể cả ca sát ngưỡng. Mỗi ca kiểm đúng TẬP mã
// luật trả về (không chỉ "có luật X"), nên một luật khác báo nhầm theo cũng bị bắt.
//
// Ngưỡng hiện tại (fraud_detection.js): ping_pong >= 6 lượt gần nhất (trong 8), đúng 2 tài khoản xen kẽ;
// burst >= 5 lượt của người đặt cuối trong 60 giây; price_jump giá mới >= 3 lần giá liền trước;
// new_account tài khoản < 10 phút đặt >= 2 lần giá khởi điểm.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-khong-dung-database';
const assert = require('assert');
const { analyze } = require('../src/services/fraud_detection');

const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const OLD_ACCOUNT = new Date(T0 - 365 * 86_400_000);
const MIN = 60_000;

// Một lượt đặt giá: who, amount, sau T0 bao nhiêu giây; tuổi tài khoản tính theo phút trước lượt đó (mặc định rất cũ).
const bid = (who, amount, sec, accountAgeMin = null) => ({
  bidderId: who,
  amount,
  at: new Date(T0 + sec * 1000),
  accountCreatedAt: accountAgeMin == null ? OLD_ACCOUNT : new Date(T0 + sec * 1000 - accountAgeMin * MIN),
});
// Dãy lượt cách đều nhau `gapSec` giây, giá tăng dần từ `from` theo `step` (không đủ để chạm luật nhảy giá).
const seq = (who, { gapSec = 70, from = 1_000_000, step = 50_000 } = {}) =>
  who.map((w, i) => bid(w, from + i * step, i * gapSec));
const codes = (bids, opts = { startPrice: 1_000_000 }) => analyze(bids, opts).map((s) => s.code);
const one = (bids, code, opts = { startPrice: 1_000_000 }) => analyze(bids, opts).find((s) => s.code === code);

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
};

console.log('Chung');
test('không có hoặc chỉ một lượt: không có tín hiệu', () => {
  assert.deepStrictEqual(analyze([]), []);
  assert.deepStrictEqual(analyze([bid('A', 1_000_000, 0)], { startPrice: 1_000_000 }), []);
});
test('phiên bình thường (nhiều người, đặt thưa, giá tăng đều): không báo gì', () => {
  assert.deepStrictEqual(codes(seq(['A', 'B', 'C', 'A', 'D', 'B', 'C', 'A'])), []);
});

console.log('ping_pong: hai tài khoản đẩy giá xen kẽ');
test('phát hiện: 6 lượt A,B,A,B,A,B', () => {
  const bids = seq(['A', 'B', 'A', 'B', 'A', 'B']);
  assert.deepStrictEqual(codes(bids), ['ping_pong']);
  const s = one(bids, 'ping_pong');
  assert.deepStrictEqual([s.severity, s.confidence], ['high', 85]);
  assert.deepStrictEqual(s.evidence, [['Số lượt xen kẽ', '6'], ['Số tài khoản tham gia (gần nhất)', '2']]);
});
test('phát hiện: chỉ xét 8 lượt gần nhất, hai người lạ đặt trước đó không che được', () => {
  assert.deepStrictEqual(codes(seq(['C', 'D', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'])), ['ping_pong']);
});
test('KHÔNG báo nhầm: ba người xen kẽ A,B,C,A,B,C,A,B', () => {
  assert.deepStrictEqual(codes(seq(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B'])), []);
});
test('KHÔNG báo nhầm: mới 5 lượt xen kẽ A,B,A,B,A (dưới ngưỡng 6)', () => {
  assert.deepStrictEqual(codes(seq(['A', 'B', 'A', 'B', 'A'])), []);
});
test('KHÔNG báo nhầm: hai người nhưng không xen kẽ hoàn toàn (A,B,A,B,B,A)', () => {
  assert.deepStrictEqual(codes(seq(['A', 'B', 'A', 'B', 'B', 'A'])), []);
});
test('KHÔNG báo nhầm: một người đặt liên tiếp (chỉ 1 tài khoản)', () => {
  assert.deepStrictEqual(codes(seq(['A', 'A', 'A', 'A', 'A', 'A'])), []);
});

console.log('burst: một tài khoản đặt dồn dập');
test('phát hiện: 5 lượt của A trong 40 giây', () => {
  const bids = [0, 10, 20, 30, 40].map((s, i) => bid('A', 1_000_000 + i * 50_000, s));
  assert.deepStrictEqual(codes(bids), ['burst']);
  const s = one(bids, 'burst');
  assert.deepStrictEqual([s.severity, s.confidence, s.evidence], ['medium', 70, [['Số lượt trong 60 giây', '5']]]);
});
test('phát hiện sát ngưỡng: 5 lượt trải đúng 60 giây (0,15,30,45,60)', () => {
  const bids = [0, 15, 30, 45, 60].map((s, i) => bid('A', 1_000_000 + i * 50_000, s));
  assert.deepStrictEqual(codes(bids), ['burst']);
});
test('phát hiện: lượt dồn dập xen lẫn người khác vẫn tính theo người đặt cuối', () => {
  const bids = [bid('A', 1_000_000, 0), bid('B', 1_050_000, 5), bid('A', 1_100_000, 10), bid('A', 1_150_000, 15),
    bid('C', 1_200_000, 20), bid('A', 1_250_000, 25), bid('A', 1_300_000, 30)];
  assert.deepStrictEqual(codes(bids), ['burst']);
});
test('KHÔNG báo nhầm: 4 lượt trong 60 giây (dưới ngưỡng 5)', () => {
  const bids = [0, 10, 20, 30].map((s, i) => bid('A', 1_000_000 + i * 50_000, s));
  assert.deepStrictEqual(codes(bids), []);
});
test('KHÔNG báo nhầm: 5 lượt nhưng trải 80 giây (chỉ 4 lượt nằm trong 60 giây cuối)', () => {
  const bids = [0, 20, 40, 60, 80].map((s, i) => bid('A', 1_000_000 + i * 50_000, s));
  assert.deepStrictEqual(codes(bids), []);
});
test('KHÔNG báo nhầm: 5 lượt trong 60 giây nhưng của 5 người khác nhau', () => {
  const bids = ['A', 'B', 'C', 'D', 'E'].map((w, i) => bid(w, 1_000_000 + i * 50_000, i * 10));
  assert.deepStrictEqual(codes(bids), []);
});

console.log('price_jump: giá nhảy bất thường');
test('phát hiện: 1.000.000 -> 3.000.000 (đúng 3 lần)', () => {
  const bids = [bid('A', 1_000_000, 0), bid('B', 3_000_000, 70)];
  assert.deepStrictEqual(codes(bids), ['price_jump']);
  const s = one(bids, 'price_jump');
  assert.deepStrictEqual([s.severity, s.confidence], ['low', 55]);
  assert.deepStrictEqual(s.evidence, [['Giá trước', '1.000.000đ'], ['Giá mới', '3.000.000đ']]);
});
test('phát hiện: 1.200.000 -> 5.000.000', () => {
  assert.deepStrictEqual(codes([bid('A', 1_200_000, 0), bid('B', 5_000_000, 70)]), ['price_jump']);
});
test('KHÔNG báo nhầm: 1.000.000 -> 2.999.000 (chưa đủ 3 lần)', () => {
  assert.deepStrictEqual(codes([bid('A', 1_000_000, 0), bid('B', 2_999_000, 70)]), []);
});
test('KHÔNG báo nhầm: tăng đều theo bước giá 50.000', () => {
  assert.deepStrictEqual(codes(seq(['A', 'B', 'C', 'D'])), []);
});
test('chỉ xét lượt cuối so với lượt liền trước: nhảy giá ở giữa dãy rồi tăng đều thì không báo', () => {
  const bids = [bid('A', 1_000_000, 0), bid('B', 4_000_000, 70), bid('C', 4_050_000, 140)];
  assert.deepStrictEqual(codes(bids), []);
});

console.log('new_account: tài khoản mới đặt giá cao');
test('phát hiện: tài khoản 5 phút tuổi đặt đúng 2 lần giá khởi điểm', () => {
  const bids = [bid('A', 1_100_000, 0), bid('N', 2_000_000, 70, 5)];
  assert.deepStrictEqual(codes(bids), ['new_account']);
  const s = one(bids, 'new_account');
  assert.deepStrictEqual([s.severity, s.confidence, s.evidence], ['medium', 60, [['Tuổi tài khoản', '5 phút']]]);
});
test('phát hiện cùng lúc hai luật: tài khoản mới nhảy giá 3,5 lần (price_jump rồi new_account)', () => {
  assert.deepStrictEqual(codes([bid('A', 1_100_000, 0), bid('N', 3_850_000, 70, 2)]), ['price_jump', 'new_account']);
});
test('KHÔNG báo nhầm: tài khoản 11 phút tuổi (đã quá 10 phút)', () => {
  assert.deepStrictEqual(codes([bid('A', 1_100_000, 0), bid('N', 2_000_000, 70, 11)]), []);
});
test('KHÔNG báo nhầm sát ngưỡng: tài khoản đúng 10 phút tuổi (ngưỡng là dưới 10 phút)', () => {
  assert.deepStrictEqual(codes([bid('A', 1_100_000, 0), bid('N', 2_000_000, 70, 10)]), []);
});
test('KHÔNG báo nhầm: tài khoản mới nhưng giá chưa tới 2 lần giá khởi điểm (1.999.999)', () => {
  assert.deepStrictEqual(codes([bid('A', 1_100_000, 0), bid('N', 1_999_999, 70, 5)]), []);
});
test('KHÔNG báo nhầm: không biết giá khởi điểm (startPrice = 0)', () => {
  assert.deepStrictEqual(codes([bid('A', 1_100_000, 0), bid('N', 2_000_000, 70, 5)], { startPrice: 0 }), []);
  assert.deepStrictEqual(codes([bid('A', 1_100_000, 0), bid('N', 2_000_000, 70, 5)], {}), []);
});
test('KHÔNG báo nhầm: tài khoản cũ đặt giá cao', () => {
  assert.deepStrictEqual(codes([bid('A', 1_100_000, 0), bid('O', 2_000_000, 70)]), []);
});

console.log(`\nTất cả ${passed} ca đạt.`);
if (process.exitCode) console.error('Có ca thất bại.');
