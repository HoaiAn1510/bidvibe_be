const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const env = require('../../src/config/env');
const { pool } = require('../../src/config/db');
const { requireAuth, requireRole } = require('../../src/middleware/auth');

async function withQueryMock(query, run) {
  const original = pool.query;
  pool.query = query;
  try {
    await run();
  } finally {
    pool.query = original;
  }
}

test('requireAuth loads an active account from a verified bearer token', async () => {
  await withQueryMock(async (sql, params) => {
    assert.match(sql, /FROM accounts/);
    assert.deepEqual(params, [42]);
    return { rows: [{ status: 'active' }] };
  }, async () => {
    const req = { headers: { authorization: `Bearer ${jwt.sign({ sub: 42, kind: 'account', role: 'seller' }, env.jwtSecret)}` } };
    let nextError;
    await requireAuth(req, {}, (error) => { nextError = error; });
    assert.equal(nextError, undefined);
    assert.deepEqual(req.user, { id: '42', kind: 'account', role: 'seller' });
  });
});

test('requireAuth rejects missing or invalid credentials before querying', async () => {
  let queried = false;
  await withQueryMock(async () => { queried = true; return { rows: [] }; }, async () => {
    for (const authorization of [undefined, 'Bearer invalid']) {
      let nextError;
      await requireAuth({ headers: { authorization } }, {}, (error) => { nextError = error; });
      assert.equal(nextError.statusCode, 401);
      assert.equal(nextError.code, 'UNAUTHORIZED');
    }
  });
  assert.equal(queried, false);
});

test('requireAuth selects the ops table and rejects suspended and missing accounts', async (t) => {
  await t.test('ops account', async () => {
    await withQueryMock(async (sql) => {
      assert.match(sql, /FROM ops_accounts/);
      return { rows: [{ status: 'active' }] };
    }, async () => {
      const token = jwt.sign({ sub: '8', kind: 'ops', role: 'admin' }, env.jwtSecret);
      const req = { headers: { authorization: `Bearer ${token}` } };
      await requireAuth(req, {}, () => {});
      assert.deepEqual(req.user, { id: '8', kind: 'ops', role: 'admin' });
    });
  });
  await t.test('suspended account', async () => {
    await withQueryMock(async () => ({ rows: [{ status: 'suspended' }] }), async () => {
      let nextError;
      const token = jwt.sign({ sub: 42, kind: 'account', role: 'bidder' }, env.jwtSecret);
      await requireAuth({ headers: { authorization: `Bearer ${token}` } }, {}, (error) => { nextError = error; });
      assert.equal(nextError.code, 'ACCOUNT_SUSPENDED');
      assert.equal(nextError.statusCode, 403);
    });
  });
  await t.test('deleted account', async () => {
    await withQueryMock(async () => ({ rows: [] }), async () => {
      let nextError;
      const token = jwt.sign({ sub: 42, kind: 'account', role: 'bidder' }, env.jwtSecret);
      await requireAuth({ headers: { authorization: `Bearer ${token}` } }, {}, (error) => { nextError = error; });
      assert.equal(nextError.code, 'UNAUTHORIZED');
    });
  });
});

test('requireRole allows permitted roles and rejects missing or disallowed users', () => {
  let nextError;
  requireRole('admin')({ user: { role: 'admin' } }, {}, (error) => { nextError = error; });
  assert.equal(nextError, undefined);

  requireRole('admin')({ user: { role: 'seller' } }, {}, (error) => { nextError = error; });
  assert.equal(nextError.code, 'FORBIDDEN');

  requireRole('admin')({}, {}, (error) => { nextError = error; });
  assert.equal(nextError.code, 'UNAUTHORIZED');
});
