const assert = require('node:assert/strict');
const test = require('node:test');
const validate = require('../../src/utils/validate');
const http = require('../../src/routes/_http');

function rejectsValidation(fn, code = 'VALIDATION_ERROR') {
  assert.throws(fn, (error) => error.code === code && error.statusCode === 400);
}

test('text trims input, supports optional fields, and enforces type and length', () => {
  assert.equal(validate.text('  item  ', 'Name'), 'item');
  assert.equal(validate.text(null, 'Name', { required: false }), null);
  rejectsValidation(() => validate.text('', 'Name'));
  rejectsValidation(() => validate.text(5, 'Name'));
  rejectsValidation(() => validate.text('long', 'Name', { max: 3 }));
});

test('email normalizes case and rejects invalid addresses', () => {
  assert.equal(validate.email(' User@Example.COM '), 'user@example.com');
  rejectsValidation(() => validate.email('not-an-email'));
});

test('password validates bcrypt-compatible length boundaries', () => {
  assert.equal(validate.password('123456'), '123456');
  assert.equal(validate.password('x'.repeat(72)).length, 72);
  rejectsValidation(() => validate.password('12345'));
  rejectsValidation(() => validate.password('x'.repeat(73)));
});

test('oneOf accepts only a listed value', () => {
  assert.equal(validate.oneOf('seller', ['seller', 'bidder'], 'Role'), 'seller');
  rejectsValidation(() => validate.oneOf('admin', ['seller', 'bidder'], 'Role'));
});

test('int handles numeric strings, optional values, and inclusive bounds', () => {
  assert.equal(validate.int('12', 'Count', { min: 1, max: 12 }), 12);
  assert.equal(validate.int('', 'Count', { required: false }), null);
  rejectsValidation(() => validate.int('1.5', 'Count'));
  rejectsValidation(() => validate.int('13', 'Count', { max: 12 }));
});

test('url and phone enforce their accepted formats', () => {
  assert.equal(validate.url('https://example.com/image.jpg'), 'https://example.com/image.jpg');
  assert.equal(validate.phone('+84 912 345 678'), '+84 912 345 678');
  assert.equal(validate.phone(null, { required: false }), null);
  rejectsValidation(() => validate.url('javascript:alert(1)'));
  rejectsValidation(() => validate.phone('1234'));
});

test('HTTP helpers normalize IDs, integers, and pagination', () => {
  assert.equal(http.idParam('123456789012345678'), '123456789012345678');
  rejectsValidation(() => http.idParam('1; DROP TABLE users'));
  assert.equal(http.intField('42', 'amount'), 42);
  rejectsValidation(() => http.intField('4.2', 'amount'));
  assert.deepEqual(http.pageParams({ limit: '500', offset: '-1' }, { max: 100 }), { limit: 100, offset: 0 });
  assert.deepEqual(http.pageParams({ limit: '0', offset: '3' }), { limit: 50, offset: 3 });
});

test('HTTP success helper emits the standard response shape', () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  assert.equal(http.ok(response, { id: 1 }, 201), response);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, { success: true, data: { id: 1 }, error: null });
});
