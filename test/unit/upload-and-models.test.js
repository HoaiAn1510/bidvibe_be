const assert = require('node:assert/strict');
const test = require('node:test');
const auctionModel = require('../../src/models/auction.model');
const uploadService = require('../../src/services/upload_service');

test('auction model masks names without exposing the full identity', () => {
  assert.equal(auctionModel.maskName('  Nguyễn Văn An  '), 'A***');
  assert.equal(auctionModel.maskName(''), '?***');
});

test('auction model derives viewer state and safe numeric view fields', () => {
  const row = {
    id: '2', listing_id: '4', title: 'Watch', category: 'antique',
    seller_id: '8', store_name: null, seller_full_name: 'Seller Name', rating: '4.5',
    starting_price: '100000', current_price: '150000', bid_step: '50000',
    deposit_required: '10000', my_balance: '20000', bid_count: 1, status: 'active',
    paused: false, before_end: true, remaining_seconds: 30, terminated: false,
    leader_id: '7', my_deposit_status: 'held', my_deposit: '10000', my_bid: '150000',
    winner_id: null,
  };
  const view = auctionModel.toView(row, '7');
  assert.equal(view.minNextBid, 200_000);
  assert.equal(view.depositAffordable, true);
  assert.equal(view.myState, 'leading');
  assert.equal(view.leading, true);
  assert.equal(view.seller.name, 'Seller Name');
  assert.equal(auctionModel.toView({ ...row, leader_id: '9' }, '7').myState, 'outbid');
  assert.equal(auctionModel.toView({ ...row, status: 'ended', winner_id: '7' }, '7').myState, 'won');
  assert.equal(auctionModel.toView({ ...row, status: 'cancelled', winner_id: null }, '7').myState, 'lost');
});

test('upload service detects supported formats from file signatures only', () => {
  const jpeg = Buffer.alloc(12);
  jpeg.set([0xff, 0xd8, 0xff]);
  const png = Buffer.alloc(12);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = Buffer.from('RIFF0000WEBPxxxx');
  assert.deepEqual(uploadService.detectType(jpeg), { ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(uploadService.detectType(png), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(uploadService.detectType(webp), { ext: 'webp', mime: 'image/webp' });
  assert.equal(uploadService.detectType(Buffer.from('not an image')), null);
  assert.equal(uploadService.detectType(Buffer.alloc(4)), null);
});
