const assert = require('node:assert/strict');
const test = require('node:test');
const { pool } = require('../../src/config/db');
const auctionModel = require('../../src/models/auction.model');
const engine = require('../../src/services/auction_engine');

test('inTransaction commits successful work and releases the client', async () => {
  const statements = [];
  const client = {
    query: async (sql) => { statements.push(sql); },
    release: () => statements.push('RELEASE'),
  };
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  try {
    const result = await engine.inTransaction(async (tx) => {
      assert.equal(tx, client);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(statements, ['BEGIN', 'COMMIT', 'RELEASE']);
  } finally {
    pool.connect = originalConnect;
  }
});

test('inTransaction rolls back failures, rethrows the cause, and releases the client', async () => {
  const statements = [];
  const client = {
    query: async (sql) => { statements.push(sql); },
    release: () => statements.push('RELEASE'),
  };
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  try {
    await assert.rejects(engine.inTransaction(async () => { throw new Error('expected failure'); }), /expected failure/);
    assert.deepEqual(statements, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  } finally {
    pool.connect = originalConnect;
  }
});

test('createAuctionForListing creates the auction with a rounded deposit then publishes the listing', async () => {
  const calls = [];
  const originalInsertAuction = auctionModel.insertAuction;
  auctionModel.insertAuction = async (_client, input) => {
    calls.push(['insertAuction', input]);
    return 'auction-21';
  };
  const client = {
    query: async (sql, values) => {
      calls.push(['query', sql, values]);
      return { rows: [{ id: 'listing-3', starting_price: '1234500', duration_hours: 24 }] };
    },
  };
  try {
    const auctionId = await engine.createAuctionForListing(client, 'listing-3');
    assert.equal(auctionId, 'auction-21');
  } finally {
    auctionModel.insertAuction = originalInsertAuction;
  }
  assert.equal(calls[0][2][0], 'listing-3');
  assert.equal(calls[1][1].depositRequired, 123_000);
  assert.equal(calls[1][1].currentPrice, 1_234_500);
  assert.match(calls[2][1], /UPDATE listings SET status = 'live'/);
});

test('createAuctionForListing reports missing listings and maps duplicate auctions', async (t) => {
  const originalInsertAuction = auctionModel.insertAuction;
  t.after(() => { auctionModel.insertAuction = originalInsertAuction; });
  const missingClient = { query: async () => ({ rows: [] }) };
  await assert.rejects(engine.createAuctionForListing(missingClient, 'missing'), { code: 'NOT_FOUND' });

  auctionModel.insertAuction = async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); };
  const duplicateClient = { query: async () => ({ rows: [{ starting_price: 100_000, duration_hours: 1 }] }) };
  await assert.rejects(engine.createAuctionForListing(duplicateClient, 'listing-3'), { code: 'AUCTION_EXISTS' });
});
