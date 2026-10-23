const assert = require('node:assert/strict');
const test = require('node:test');
const walletModel = require('../../src/models/wallet.model');
const wallet = require('../../src/services/wallet_service');

async function withModelMocks(mocks, run) {
  const originals = {};
  for (const [name, implementation] of Object.entries(mocks)) {
    originals[name] = walletModel[name];
    walletModel[name] = implementation;
  }
  try {
    await run();
  } finally {
    for (const [name, implementation] of Object.entries(originals)) walletModel[name] = implementation;
  }
}

const client = {};

test('topUp validates amount, adjusts balance, and records a ledger transaction', async () => {
  const calls = [];
  await withModelMocks({
    adjust: async (...args) => { calls.push(['adjust', ...args]); return { balance: 1_000 }; },
    insertTx: async (...args) => { calls.push(['insertTx', ...args]); return { kind: 'topup' }; },
  }, async () => {
    assert.deepEqual(await wallet.topUp(client, { bidderId: '7', amount: 1_000 }), { kind: 'topup' });
  });
  assert.deepEqual(calls, [
    ['adjust', client, '7', { balance: 1_000 }],
    ['insertTx', client, { bidderId: '7', kind: 'topup', amount: 1_000, balanceAfter: 1_000 }],
  ]);
});

test('topUp rejects invalid amounts before touching the wallet', async () => {
  let touched = false;
  await withModelMocks({ adjust: async () => { touched = true; } }, async () => {
    await assert.rejects(wallet.topUp(client, { bidderId: '7', amount: 0 }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(wallet.topUp(client, { bidderId: '7', amount: 100_000_001 }), { code: 'VALIDATION_ERROR' });
  });
  assert.equal(touched, false);
});

test('holdDeposit transfers available balance to held and records the hold', async () => {
  const calls = [];
  await withModelMocks({
    adjust: async (...args) => { calls.push(['adjust', ...args]); return { balance: 900, held: 100 }; },
    insertTx: async (...args) => { calls.push(['insertTx', ...args]); return { kind: 'deposit_hold' }; },
  }, async () => {
    await wallet.holdDeposit(client, { bidderId: '7', auctionId: '9', amount: 100 });
  });
  assert.deepEqual(calls[0], ['adjust', client, '7', { balance: -100, held: 100 }]);
  assert.deepEqual(calls[1][2], {
    bidderId: '7', kind: 'deposit_hold', amount: 100, auctionId: '9', balanceAfter: 900,
  });
});

test('holdDeposit reports insufficient funds and writes no transaction', async () => {
  let ledgerWrites = 0;
  await withModelMocks({
    adjust: async () => null,
    getBalances: async () => ({ balance: 25, held: 0 }),
    insertTx: async () => { ledgerWrites += 1; },
  }, async () => {
    await assert.rejects(
      wallet.holdDeposit(client, { bidderId: '7', auctionId: '9', amount: 100 }),
      { code: 'INSUFFICIENT_FUNDS', statusCode: 402 },
    );
  });
  assert.equal(ledgerWrites, 0);
});

test('releaseDeposit and forfeitDeposit use distinct balance and held movements', async () => {
  const adjustments = [];
  const entries = [];
  await withModelMocks({
    adjust: async (...args) => { adjustments.push(args[2]); return { balance: 500, held: 0 }; },
    insertTx: async (_client, entry) => { entries.push(entry); return entry; },
  }, async () => {
    await wallet.releaseDeposit(client, { bidderId: '7', auctionId: '9', amount: 100 });
    await wallet.forfeitDeposit(client, { bidderId: '7', auctionId: '9', amount: 100 });
  });
  assert.deepEqual(adjustments, [{ balance: 100, held: -100 }, { held: -100 }]);
  assert.deepEqual(entries.map(({ kind }) => kind), ['deposit_release', 'deposit_forfeit']);
});

test('payOrder applies the deposit and debits only the wallet remainder when wallet-paid', async () => {
  const calls = [];
  await withModelMocks({
    adjust: async (...args) => { calls.push(['adjust', ...args]); return { balance: 400, held: 0 }; },
    insertTx: async (...args) => { calls.push(['insertTx', ...args]); return { kind: 'payment' }; },
  }, async () => {
    await wallet.payOrder(client, {
      bidderId: '7', auctionId: '9', totalDue: 500, depositAmount: 100, viaWallet: true,
    });
  });
  assert.deepEqual(calls[0], ['adjust', client, '7', { balance: -400, held: -100 }]);
  assert.equal(calls[1][2].amount, 500);
  assert.equal(calls[1][2].kind, 'payment');
});

test('payOrder leaves wallet balance untouched for external payment but consumes deposit', async () => {
  let adjustment;
  await withModelMocks({
    adjust: async (_client, _bidderId, change) => { adjustment = change; return { balance: 800, held: 0 }; },
    insertTx: async () => ({ kind: 'payment' }),
  }, async () => {
    await wallet.payOrder(client, {
      bidderId: '7', auctionId: '9', totalDue: 500, depositAmount: 100, viaWallet: false,
    });
  });
  assert.deepEqual(adjustment, { balance: 0, held: -100 });
});

test('refund requires positive integer and records the wallet credit', async () => {
  let entry;
  await withModelMocks({
    adjust: async () => ({ balance: 1_500, held: 0 }),
    insertTx: async (_client, tx) => { entry = tx; return tx; },
  }, async () => {
    await assert.rejects(wallet.refund(client, { bidderId: '7', amount: -1 }), { code: 'VALIDATION_ERROR' });
    await wallet.refund(client, { bidderId: '7', amount: 500, auctionId: '9' });
  });
  assert.deepEqual(entry, {
    bidderId: '7', kind: 'refund', amount: 500, auctionId: '9', balanceAfter: 1_500,
  });
});
