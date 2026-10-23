# Unit test results

## Scope

This isolated unit suite covers selected unit-testable core behavior: shared input/HTTP helpers, authentication and role middleware, wallet balance/ledger transaction rules, auction transaction boundaries and listing-to-auction creation, auction view mapping, uploaded-image signature validation, AI price suggestion calculations, dispute evidence URL rules, chatbot transaction behavior, and notification commit/emission semantics. The existing fraud detection unit suite is also included in the standard `npm test` chain.

The tests use Node's built-in `node:test` runner and mocked database clients/model methods. They do not connect to PostgreSQL, call Supabase Storage, start the server, or modify application data. Existing `test:be1` and `test:be2` suites are integration tests; they were not run because they use the shared database. This is not exhaustive function-by-function coverage of all 52 source files or every business workflow. Database-heavy services and route handlers still need dedicated mock tests or an isolated integration database.

## Command

```text
npm run test:unit
```

## Result

- `npm run test:unit` — **PASS**, 41 tests, 0 failures.
- `npm run test:fraud` — **PASS**, 45 cases, 0 failures.
- `npm test` was not run because it continues on to `test:be1` and `test:be2`, which use the shared database.

## Files added

- `test/unit/validation.test.js`
- `test/unit/wallet-service.test.js`
- `test/unit/auction-engine.test.js`
- `test/unit/auth-middleware.test.js`
- `test/unit/upload-and-models.test.js`
- `test/unit/be2-services.test.js`
- `test/unit/notification-service.test.js`
