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
const { analyze, normalizePhone, maskPhone } = require('../src/services/fraud_detection');

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

// ---------------------------------------------------------------------------------------------------------------
// Luật theo danh tính (cần context: số điện thoại, lịch sử người đặt giá). Không có context thì không luật nào chạy.
const START = { startPrice: 1_000_000 };
const hist = (over = {}) => ({ totalBids: 10, sellerBids: 8, sellerAuctions: 3, paidWins: 0, forfeits: 0, lastForfeitAt: null, ...over });
const two = [bid('A', 1_000_000, 0), bid('B', 1_050_000, 70)];
const signal = (bids, ctx, code) => analyze(bids, { ...START, ...ctx }).find((s) => s.code === code);
const allText = (s) => JSON.stringify([s.reason, s.explanation, s.evidence]);

console.log('seller_alt_account: người đặt giá trùng số điện thoại với người bán');
test('phát hiện: "0901 234 567" của người bán và "+84901234567" của người đặt giá (hai định dạng khác nhau)', () => {
  const ctx = { sellerPhone: '0901 234 567', bidderPhones: { A: '+84901234567', B: '0377 111 222' } };
  assert.deepStrictEqual(codes(two, { ...START, ...ctx }), ['seller_alt_account']);
  const s = signal(two, ctx, 'seller_alt_account');
  assert.deepStrictEqual([s.severity, s.confidence, s.reason], ['high', 90, 'Người đặt giá trùng số điện thoại với người bán']);
});
test('bằng chứng che số điện thoại (090****567), kèm số lượt giá của tài khoản; không lộ đủ số', () => {
  const bids = [bid('A', 1_000_000, 0), bid('B', 1_050_000, 70), bid('A', 1_100_000, 140)];
  const s = signal(bids, { sellerPhone: '0901.234.567', bidderPhones: { A: '090-1234-567' } }, 'seller_alt_account');
  assert.deepStrictEqual(s.evidence, [['Tài khoản #A · số điện thoại trùng (đã che)', '090****567'], ['Tài khoản #A · số lượt giá trong phiên', '2']]);
  const text = allText(s);
  for (const leak of ['0901234567', '901234567', '1234567', '234567', '+84']) assert.ok(!text.includes(leak), `lộ ${leak}: ${text}`);
});
test('các định dạng +84, 84, 0084, dấu chấm, gạch, ngoặc đều chuẩn hoá về cùng một số', () => {
  for (const raw of ['+84901234567', '+84 901 234 567', '84901234567', '0084901234567', '0901.234.567', '090-123-4567', '(090) 1234 567']) {
    assert.strictEqual(normalizePhone(raw), '0901234567', raw);
  }
  assert.strictEqual(maskPhone('0901234567'), '090****567');
});
test('một lượt giá là đủ để phát hiện; hai tài khoản cùng trùng số vẫn chỉ một tín hiệu, bằng chứng của cả hai', () => {
  assert.deepStrictEqual(codes([bid('A', 1_000_000, 0)], { ...START, sellerPhone: '0901234567', bidderPhones: { A: '0901234567' } }), ['seller_alt_account']);
  const s = signal(two, { sellerPhone: '0901234567', bidderPhones: { A: '0901234567', B: '+84901234567' } }, 'seller_alt_account');
  assert.strictEqual(s.evidence.length, 4);
  assert.ok(s.evidence.some(([l]) => l.includes('#A')) && s.evidence.some(([l]) => l.includes('#B')));
});
test('KHÔNG báo nhầm: số điện thoại khác nhau', () => {
  assert.deepStrictEqual(codes(two, { ...START, sellerPhone: '0901234567', bidderPhones: { A: '0901234568', B: '0911234567' } }), []);
});
test('KHÔNG báo nhầm: số rỗng, thiếu hoặc quá ngắn (hai số rỗng không được coi là trùng)', () => {
  for (const [sellerPhone, bidderPhone] of [['', ''], [null, null], ['   ', '  '], ['0901234567', ''], ['0901234567', null], ['', '0901234567'], ['12345', '12345'], ['abc', 'abc']]) {
    assert.deepStrictEqual(codes(two, { ...START, sellerPhone, bidderPhones: { A: bidderPhone, B: bidderPhone } }), [], JSON.stringify([sellerPhone, bidderPhone]));
  }
  assert.deepStrictEqual(codes(two, { ...START, sellerPhone: '0901234567', bidderPhones: {} }), []);
});

console.log('seller_affinity: gần như chỉ đặt giá phiên của một người bán');
test('phát hiện sát ngưỡng: 3 phiên, 8/10 lượt = 80%, chưa thắng thanh toán phiên nào', () => {
  const ctx = { bidderHistory: { A: hist() } };
  assert.deepStrictEqual(codes(two, { ...START, ...ctx }), ['seller_affinity']);
  const s = signal(two, ctx, 'seller_affinity');
  assert.deepStrictEqual([s.severity, s.confidence, s.reason], ['medium', 70, 'Tài khoản gần như chỉ đặt giá phiên của một người bán']);
  assert.deepStrictEqual(s.evidence.map(([, v]) => v), ['3', '80% (8/10 lượt)', '0']);
});
test('phát hiện: nhiều tài khoản cùng vi phạm thì một tín hiệu, bằng chứng của từng tài khoản; chỉ xét người đang đặt giá', () => {
  const ctx = { bidderHistory: { A: hist(), B: hist({ sellerAuctions: 5, sellerBids: 10, totalBids: 10 }), Z: hist() } }; // Z không đặt giá trong phiên này
  const s = signal(two, ctx, 'seller_affinity');
  assert.strictEqual(s.evidence.length, 6);
  assert.ok(!allText(s).includes('#Z'));
});
test('KHÔNG báo nhầm: chỉ 2 phiên của người bán (dưới 3)', () => {
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: { A: hist({ sellerAuctions: 2 }) } }), []);
});
test('KHÔNG báo nhầm: đặt giá rải đều nhiều người bán (79 trên 100 lượt = 79%, dưới 80%)', () => {
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: { A: hist({ sellerBids: 79, totalBids: 100 }) } }), []);
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: { A: hist({ sellerBids: 3, totalBids: 12, sellerAuctions: 3 }) } }), []);
});
test('KHÔNG báo nhầm: người mua đã thắng và thanh toán phiên của người bán này', () => {
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: { A: hist({ paidWins: 1 }) } }), []);
});
test('KHÔNG báo nhầm: không có lịch sử, hoặc tổng lượt giá bằng 0 (không chia cho 0)', () => {
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: {} }), []);
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: { A: hist({ totalBids: 0, sellerBids: 0 }) } }), []);
});

console.log('repeat_forfeiter: người dẫn đầu từng thắng rồi bỏ không thanh toán');
test('phát hiện: người dẫn đầu (lượt cuối) bị tịch thu cọc 1 lần; bằng chứng có số lần và lần gần nhất theo giờ Việt Nam', () => {
  const ctx = { bidderHistory: { B: hist({ totalBids: 4, sellerBids: 1, sellerAuctions: 1, forfeits: 1, lastForfeitAt: new Date(Date.UTC(2026, 9, 1, 8, 0, 0)) }) } };
  assert.deepStrictEqual(codes(two, { ...START, ...ctx }), ['repeat_forfeiter']);
  const s = signal(two, ctx, 'repeat_forfeiter');
  assert.deepStrictEqual([s.severity, s.confidence, s.reason], ['low', 60, 'Người dẫn đầu từng thắng rồi bỏ không thanh toán']);
  assert.deepStrictEqual(s.evidence.map(([, v]) => v), ['1', '15:00 01/10/2026']); // 08:00 UTC = 15:00 giờ Việt Nam
});
test('phát hiện: bị tịch thu nhiều lần thì ghi đúng số lần', () => {
  const s = signal(two, { bidderHistory: { B: hist({ totalBids: 4, sellerBids: 1, sellerAuctions: 1, forfeits: 3, lastForfeitAt: new Date(T0) }) } }, 'repeat_forfeiter');
  assert.strictEqual(s.evidence[0][1], '3');
});
test('KHÔNG báo nhầm: người dẫn đầu chưa từng bỏ đơn (forfeits = 0)', () => {
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: { B: hist({ totalBids: 4, sellerBids: 1, sellerAuctions: 1 }) } }), []);
});
test('KHÔNG báo nhầm: người từng bỏ đơn không phải người đang dẫn đầu', () => {
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: { A: hist({ totalBids: 4, sellerBids: 1, sellerAuctions: 1, forfeits: 2, lastForfeitAt: new Date(T0) }), B: hist({ totalBids: 4, sellerBids: 1, sellerAuctions: 1 }) } }), []);
});
test('KHÔNG báo nhầm: không có lịch sử của người dẫn đầu', () => {
  assert.deepStrictEqual(codes(two, { ...START, bidderHistory: {} }), []);
});

console.log('Kết hợp');
test('nhiều luật cùng lúc: thứ tự tín hiệu là bốn luật mẫu lượt giá rồi seller_alt_account, seller_affinity, repeat_forfeiter', () => {
  const bids = [bid('A', 1_100_000, 0), bid('B', 3_850_000, 70, 2)]; // price_jump + new_account
  const ctx = {
    startPrice: 1_000_000, sellerPhone: '0901234567', bidderPhones: { B: '0901234567' },
    bidderHistory: { B: hist({ forfeits: 1, lastForfeitAt: new Date(T0) }) },
  };
  assert.deepStrictEqual(codes(bids, ctx), ['price_jump', 'new_account', 'seller_alt_account', 'seller_affinity', 'repeat_forfeiter']);
});
test('context bỏ trống: chỉ bốn luật theo mẫu lượt giá chạy (tương thích cách gọi cũ)', () => {
  assert.deepStrictEqual(codes([bid('A', 1_000_000, 0), bid('B', 3_000_000, 70)], { startPrice: 1_000_000 }), ['price_jump']);
  assert.deepStrictEqual(analyze([bid('A', 1_000_000, 0), bid('B', 3_000_000, 70)]).map((s) => s.code), ['price_jump']);
});

console.log(`\nTất cả ${passed} ca đạt.`);
if (process.exitCode) console.error('Có ca thất bại.');
