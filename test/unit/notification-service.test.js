const assert = require('node:assert/strict');
const test = require('node:test');
const { pool } = require('../../src/config/db');
const realtime = require('../../src/sockets/broadcast');

const emitted = [];
const originalBroadcast = realtime.broadcast;
realtime.broadcast = (...args) => emitted.push(args);
const notifications = require('../../src/services/notification_service');

test.after(() => {
  realtime.broadcast = originalBroadcast;
});

async function withPoolQuery(query, run) {
  const original = pool.query;
  pool.query = query;
  try {
    await run();
  } finally {
    pool.query = original;
  }
}

test('notification data normalizes identifiers and drops empty values', async () => {
  await withPoolQuery(async (_sql, params) => {
    assert.deepEqual(params[3], { orderId: '23', enabled: 'false' });
    return { rows: [{ id: 1, type: 'win', title: 'Won', data: params[3], is_read: false, created_at: 'now' }] };
  }, async () => {
    const result = await notifications.createNotification(pool, {
      accountId: 7, type: 'win', title: 'Won', data: { orderId: 23, enabled: false, skip: '', none: null },
    });
    assert.equal(result.accountId, '7');
    assert.deepEqual(result.data, { orderId: '23', enabled: 'false' });
  });
});

test('transaction-scoped notify writes but leaves emission to the caller after commit', async () => {
  emitted.length = 0;
  const tx = {
    query: async (_sql, params) => ({
      rows: [{ id: 2, type: params[1], title: params[2], data: params[3], is_read: false, created_at: 'now' }],
    }),
  };
  const notification = await notifications.notify(tx, 'user-4', 'refund', 'Refunded');
  assert.deepEqual(emitted, []);

  notifications.emitNotification(notification);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'user:user-4');
  assert.equal(emitted[0][1], 'notification:new');
  assert.equal(emitted[0][2].id, 2);
});

test('non-transactional notify emits after persisting through the pool', async () => {
  emitted.length = 0;
  await withPoolQuery(async (_sql, params) => ({
    rows: [{ id: 3, type: params[1], title: params[2], data: null, is_read: false, created_at: 'now' }],
  }), async () => {
    await notifications.notify(pool, 'user-5', 'outbid', 'Outbid');
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'user:user-5');
  assert.equal(emitted[0][2].id, 3);
});

test('internal users are forbidden from notification account operations', async () => {
  await assert.rejects(
    notifications.listForAccount({ id: 'ops-2', kind: 'ops' }, { limit: 20, offset: 0 }),
    { code: 'FORBIDDEN' },
  );
});
