const assert = require('node:assert/strict');
const test = require('node:test');
const { pool } = require('../../src/config/db');
const uploadService = require('../../src/services/upload_service');
const disputePhotos = require('../../src/services/dispute_photos');
const chat = require('../../src/services/chat_service');
const priceSuggestion = require('../../src/services/ai_price_suggestion');

async function withPoolMethod(name, implementation, run) {
  const original = pool[name];
  pool[name] = implementation;
  try {
    await run();
  } finally {
    pool[name] = original;
  }
}

test('price suggestions use the documented fallback and condition factor', async () => {
  await withPoolMethod('query', async (sql) => {
    if (sql.includes('FROM categories')) return { rowCount: 1, rows: [{}] };
    return { rows: [] };
  }, async () => {
    const result = await priceSuggestion.suggestPrice({ categoryCode: 'shoes', condition: 'Như mới' });
    assert.deepEqual(result, {
      suggestedStartingPrice: 2_090_000,
      expectedFinalRange: [880_000, 3_300_000],
      basis: 'default',
      sampleSize: 0,
      explanation: 'Chưa đủ lịch sử phiên cùng danh mục, đây là khung giá tham khảo soạn sẵn. Đây là gợi ý tham khảo, chưa dùng mô hình AI.',
    });
  });
});

test('price suggestions use sample percentiles when ended auction history is sufficient', async () => {
  await withPoolMethod('query', async (sql) => {
    if (sql.includes('FROM categories')) return { rowCount: 1, rows: [{}] };
    return {
      rows: [
        { id: 1, starting_price: '1000000', final_price: '1000000' },
        { id: 2, starting_price: '2000000', final_price: '2000000' },
        { id: 3, starting_price: '3000000', final_price: '3000000' },
      ],
    };
  }, async () => {
    const result = await priceSuggestion.suggestPrice({ categoryCode: 'shoes', condition: 'hư nhẹ' });
    assert.equal(result.basis, 'history');
    assert.equal(result.sampleSize, 3);
    assert.equal(result.suggestedStartingPrice, 1_600_000);
    assert.deepEqual(result.expectedFinalRange, [1_500_000, 2_500_000]);
  });
});

test('price suggestions reject an unknown category without querying auction history', async () => {
  let calls = 0;
  await withPoolMethod('query', async () => { calls += 1; return { rowCount: 0, rows: [] }; }, async () => {
    await assert.rejects(
      priceSuggestion.suggestPrice({ categoryCode: 'missing' }),
      { code: 'VALIDATION_ERROR' },
    );
  });
  assert.equal(calls, 1);
});

test('dispute evidence URL parsing validates, trims, de-duplicates, and enforces limits', (t) => {
  const original = uploadService.pathFromPublicUrl;
  uploadService.pathFromPublicUrl = (url) => url.startsWith('https://storage.test/') ? url.slice(22) : null;
  t.after(() => { uploadService.pathFromPublicUrl = original; });

  assert.deepEqual(disputePhotos.parsePhotoUrls([
    ' https://storage.test/a.jpg ',
    'https://storage.test/a.jpg',
    'https://storage.test/b.jpg',
  ]), ['https://storage.test/a.jpg', 'https://storage.test/b.jpg']);
  assert.deepEqual(disputePhotos.parsePhotoUrls(null), []);
  assert.throws(() => disputePhotos.parsePhotoUrls([], { required: true }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => disputePhotos.parsePhotoUrls(['https://foreign.test/a.jpg']), { code: 'INVALID_PHOTO_URL' });
  assert.throws(() => disputePhotos.parsePhotoUrls(Array(7).fill('https://storage.test/a.jpg')), { code: 'TOO_MANY_FILES' });
});

test('dispute evidence insert skips empty data and count maps the query result', async () => {
  const queries = [];
  const client = {
    query: async (...args) => {
      queries.push(args);
      return { rows: [{ n: 2 }] };
    },
  };
  await disputePhotos.insertPhotos(client, '5', [], { kind: 'account', id: '2', role: 'buyer' });
  assert.equal(await disputePhotos.countPhotos(client, '5'), 2);
  assert.equal(queries.length, 1);
  assert.match(queries[0][0], /SELECT count\(\*\)::int AS n FROM dispute_photos/);
});

test('chat sendMessage stores a user question and scripted answer in one transaction', async () => {
  const statements = [];
  let messageId = 0;
  const client = {
    query: async (sql, params = []) => {
      statements.push(sql);
      if (sql.includes('INSERT INTO chat_sessions')) return { rows: [{ id: 'session-2' }] };
      if (sql.includes('INSERT INTO chat_messages')) {
        messageId += 1;
        return {
          rows: [{ id: messageId, sender: params[1], content: params[2], created_at: new Date('2026-01-01T00:00:00Z') }],
        };
      }
      return { rows: [] };
    },
    release: () => statements.push('RELEASE'),
  };
  await withPoolMethod('connect', async () => client, async () => {
    const result = await chat.sendMessage({ id: 'account-1', kind: 'account' }, { content: 'Tôi cần đặt cọc thế nào?' });
    assert.equal(result.sessionId, 'session-2');
    assert.equal(result.messages[0].sender, 'user');
    assert.equal(result.messages[0].content, 'Tôi cần đặt cọc thế nào?');
    assert.equal(result.messages[1].sender, 'bot');
    assert.match(result.messages[1].content, /đặt cọc 10%/);
  });
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-2), 'COMMIT');
  assert.equal(statements.at(-1), 'RELEASE');
});

test('chat rejects internal users and invalid questions before opening a transaction', async () => {
  let connected = false;
  await withPoolMethod('connect', async () => { connected = true; throw new Error('unexpected connection'); }, async () => {
    await assert.rejects(chat.sendMessage({ id: 'ops-1', kind: 'ops' }, { content: 'help' }), { code: 'FORBIDDEN' });
    await assert.rejects(chat.sendMessage({ id: 'account-1', kind: 'account' }, { content: '' }), { code: 'VALIDATION_ERROR' });
  });
  assert.equal(connected, false);
});
