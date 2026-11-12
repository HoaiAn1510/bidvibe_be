// Test đơn vị (không cần DB): gợi ý giá và bộ hiểu câu hỏi của chatbot. Chạy: npm run test:ai
const assert = require('node:assert/strict');
const { estimate } = require('../src/services/ai_price_suggestion');
const knowledge = require('../src/services/chat_knowledge');

let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const h = (title, start, final) => ({ title, startingPrice: start, finalPrice: final });

console.log('Gợi ý giá');
t('ít hơn 3 phiên -> khung giá soạn sẵn (basis default)', () => {
  const r = estimate({ categoryCode: 'shoes', history: [h('a', 1, 2)] });
  assert.equal(r.basis, 'default');
  assert.equal(r.suggestedStartingPrice, 1_900_000);
});
t('đủ lịch sử -> basis history, đúng dạng dữ liệu API', () => {
  const r = estimate({ categoryCode: 'elec', history: [h('x', 1_000_000, 2_000_000), h('y', 2_000_000, 3_000_000), h('z', 3_000_000, 4_000_000)] });
  assert.equal(r.basis, 'history');
  assert.equal(r.sampleSize, 3);
  assert.equal(r.suggestedStartingPrice, 2_000_000);
  assert.deepEqual(r.expectedFinalRange, [2_500_000, 3_500_000]);
  assert.ok(Array.isArray(r.expectedFinalRange) && typeof r.explanation === 'string');
});
t('tình trạng áp cho cả khoảng giá chốt', () => {
  const hist = [h('x', 1_000_000, 2_000_000), h('y', 2_000_000, 3_000_000), h('z', 3_000_000, 4_000_000)];
  const r = estimate({ categoryCode: 'elec', history: hist, factor: 0.8 });
  assert.equal(r.suggestedStartingPrice, 1_600_000);
  assert.deepEqual(r.expectedFinalRange, [2_000_000, 2_800_000]);
});
t('phiên có giá chốt ngoại lệ bị loại', () => {
  const hist = [1, 2, 3, 4, 5].map((i) => h(`m${i}`, 1_000_000, 2_000_000 + i * 10_000)).concat([h('lạ', 1_000_000, 90_000_000)]);
  const r = estimate({ categoryCode: 'antique', history: hist });
  assert.equal(r.sampleSize, 5);
  assert.ok(r.expectedFinalRange[1] < 3_000_000);
});
t('có title -> ưu tiên phiên tên tương tự', () => {
  const hist = [
    h('Máy ảnh film Canon AE-1', 3_000_000, 5_000_000), h('Máy ảnh Canon cổ', 3_200_000, 5_200_000), h('Canon Sure Shot', 2_800_000, 4_800_000),
    h('Loa Marshall', 9_000_000, 12_000_000), h('Radio Philips', 8_000_000, 11_000_000),
  ];
  const r = estimate({ categoryCode: 'elec', history: hist, title: 'Canon AE-1 chính hãng' });
  assert.equal(r.sampleSize, 3);
  assert.ok(r.suggestedStartingPrice <= 3_200_000);
  assert.match(r.explanation, /tương tự/);
});
t('title không đủ mẫu tương tự -> quay về cả danh mục', () => {
  const hist = [h('A', 1_000_000, 2_000_000), h('B', 1_000_000, 2_000_000), h('C', 1_000_000, 2_000_000)];
  const r = estimate({ categoryCode: 'elec', history: hist, title: 'Zzzz hiếm' });
  assert.equal(r.sampleSize, 3);
  assert.doesNotMatch(r.explanation, /tương tự/);
});

console.log('Chatbot');
const topic = (q, prev) => knowledge.answer(q, { previousTopic: prev }).topic;
t('hỏi có dấu và không dấu cho cùng chủ đề', () => {
  assert.equal(topic('Đặt cọc như thế nào?'), 'deposit');
  assert.equal(topic('dat coc nhu the nao'), 'deposit');
  assert.equal(topic('coc co mat ko'), 'deposit');
});
t('câu trả lời về cọc có 10% (khớp test_be2)', () => {
  assert.ok(knowledge.answer('Đặt cọc như thế nào?').text.includes('10%'));
});
t('giải ngân / thanh toán / tranh chấp', () => {
  assert.equal(topic('Bao lâu thì giải ngân?'), 'payout');
  assert.equal(topic('quá hạn thanh toán thì sao'), 'payment');
  assert.equal(topic('hàng không đúng mô tả thì làm sao'), 'dispute');
});
t('chỉ một người đấu giá vẫn thắng', () => {
  const r = knowledge.answer('chỉ có 1 người đấu giá thì có thắng không');
  assert.equal(r.topic, 'winner');
  assert.match(r.text, /chỉ có một người/);
});
t('"vì sao" không bị hiểu thành "ví"', () => {
  assert.notEqual(topic('vì sao bạn giỏi vậy'), 'wallet');
  assert.equal(topic('ví của tôi nạp thế nào'), 'wallet');
});
t('câu nối tiếp dùng chủ đề trước', () => {
  const r = knowledge.answer('vậy còn gì nữa?', { previousTopic: 'deposit' });
  assert.equal(r.topic, 'deposit');
  assert.equal(r.text, knowledge.TOPICS.deposit.more);
});
t('xã giao và câu không hiểu', () => {
  assert.match(knowledge.answer('xin chào').text, /Chào|Xin chào/);
  assert.match(knowledge.answer('cảm ơn nhé').text, /Không có gì|vui/);
  assert.match(knowledge.answer('asdf qwer zxcv').text, /chưa hiểu/);
});

console.log(`\n${passed} test đạt${process.exitCode ? ', CÓ LỖI' : ''}`);
