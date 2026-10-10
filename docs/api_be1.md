# API — Auction Core (BE1)

Mọi endpoint cần header `Authorization: Bearer <token>` (lấy từ `POST /api/auth/login`).
Phản hồi theo format chung của `middleware/errorHandler.js`:

```json
{ "success": true,  "data": { ... }, "error": null }
{ "success": false, "data": null,    "error": { "code": "BID_TOO_LOW", "message": "Giá tối thiểu là 1.300.000đ" } }
```

Tiền là VND (số nguyên). Thời gian là chuỗi ISO 8601 (UTC). Id là **chuỗi số** (`"12"`); id sai định dạng → `400 VALIDATION_ERROR`.
Real-time (Socket.io): xem [`socket.md`](socket.md). Route BE2 (đăng tin, kho, tranh chấp, thông báo...): xem [`api.md`](api.md).

## Kết nối từ app Flutter

| Chạy trên | Base URL |
|---|---|
| Android Emulator | `http://10.0.2.2:5000` |
| Điện thoại thật (cùng Wi-Fi) | `http://<IP máy tính>:5000` (mở cổng 5000 trên firewall) |
| Windows/Web/iOS Simulator | `http://localhost:5000` |

Server lắng nghe `0.0.0.0` nên emulator truy cập được. Android 9+ chặn HTTP thuần: thêm
`android:usesCleartextTraffic="true"` vào thẻ `<application>` của `AndroidManifest.xml` (và quyền `INTERNET`).

## Danh sách route BE1

| Method | Đường dẫn | Vai trò | Mục |
|---|---|---|---|
| GET | `/api/auctions` | mọi tài khoản đã đăng nhập | [Phiên](#phiên-đấu-giá--apiauctions) |
| GET | `/api/auctions/:id` | mọi tài khoản đã đăng nhập | [Phiên](#phiên-đấu-giá--apiauctions) |
| POST | `/api/auctions/:id/join` | bidder | [Đặt cọc](#đặt-cọc-tham-gia--post-apiauctionsidjoin-bidder) |
| POST | `/api/auctions/:id/report` | bidder | [Báo cáo](#báo-cáo-phiên-đáng-ngờ--post-apiauctionsidreport-bidder) |
| POST | `/api/bids` | bidder | [Đặt giá](#đặt-giá--post-apibids-bidder) |
| GET | `/api/wallet` | bidder | [Ví](#ví--apiwallet-bidder) |
| GET | `/api/wallet/transactions` | bidder | [Ví](#ví--apiwallet-bidder) |
| POST | `/api/wallet/topup` | bidder | [Ví](#ví--apiwallet-bidder) |
| GET | `/api/orders/mine` | bidder | [Đơn thắng](#đơn-thắng--apiorders-bidder) |
| GET | `/api/orders/:id` | bidder | [Đơn thắng](#đơn-thắng--apiorders-bidder) |
| POST | `/api/orders/:id/pay` | bidder | [Đơn thắng](#đơn-thắng--apiorders-bidder) |

Các route `/api/orders/selling`, `/:id/ship-to-warehouse`, `/:id/shipping-address`, `/:id/confirm-delivery`,
`/:id/tracking` thuộc BE2 (`fulfilment.routes.js`, mount trước router BE1).

## Phiên đấu giá — `/api/auctions`

### `GET /api/auctions`

Query (đều tuỳ chọn): `status=live|ended|joined`, `category=shoes|elec|antique`, `q` (tìm theo tiêu đề),
`sort=ending|newest|price_asc|price_desc|popular` (mặc định `ending`), `limit` (1–100, mặc định 50), `offset`.
`joined` = các phiên mình đã đặt cọc.

```json
{ "success": true, "error": null, "data": { "auctions": [ {
  "id": "12", "listingId": "40", "title": "Giày chạy bộ bản giới hạn, size 43", "category": "shoes",
  "description": "Bản phối màu giới hạn...", "condition": "Mới 95%, đã đi 2 lần", "coverUrl": null,
  "seller": { "id": "3", "storeName": "Sneaker Sài Gòn", "rating": 4.9 },
  "startPrice": 1200000, "currentPrice": 1250000, "bidStep": 50000, "depositRequired": 120000, "bidCount": 1,
  "startsAt": "2026-10-08T08:00:00.000Z", "endsAt": "2026-10-12T12:00:00.000Z",
  "status": "active", "isLive": true, "paused": false, "pausedAt": null, "remainingSeconds": 151200,
  "terminated": false, "winnerId": null,
  "joined": true, "myDepositStatus": "held", "myDeposit": 120000, "myBid": 1250000, "leading": true, "won": false
} ] } }
```

| Trường | Ý nghĩa |
|---|---|
| `status` | `active` / `ended` / `cancelled` (`auctions.status`) |
| `isLive` | Đang nhận cọc và lượt giá (`active`, chưa hết giờ, không tạm dừng) |
| `paused`, `pausedAt` | Admin tạm dừng để kiểm tra. **Đồng hồ đứng yên** trong lúc dừng; khi tiếp tục, `endsAt` được cộng thêm đúng thời gian đã dừng |
| `remainingSeconds` | Số giây còn lại do server tính (đứng yên khi `paused`); dùng để hiển thị đếm ngược thay vì tự lấy `endsAt - now` lúc đang dừng |
| `joined`, `myDepositStatus`, `myDeposit`, `myBid`, `leading`, `won` | Riêng của người đang xem (tài khoản nội bộ thì luôn rỗng) |

### `GET /api/auctions/:id`

Cùng cấu trúc như một phần tử ở trên, thêm `bids`: 20 lượt giá gần nhất (mới nhất trước), tên đã che.

```json
"bids": [ { "id": "88", "who": "A***", "amount": 1250000, "at": "2026-10-10T08:29:41.120Z", "me": true } ]
```

Lỗi: `404 NOT_FOUND`.

### Đặt cọc tham gia — `POST /api/auctions/:id/join` (bidder)

Không có body. Giữ cọc = 10% giá khởi điểm (làm tròn nghìn) từ ví sang `held`.

```json
// 201
{ "success": true, "error": null, "data": { "depositId": "31", "deposit": 120000, "balanceAfter": 19880000 } }
```

Lỗi: `402 INSUFFICIENT_FUNDS`, `409 ALREADY_JOINED`, `409 AUCTION_ENDED`, `409 AUCTION_PAUSED`, `404 NOT_FOUND`.

### Báo cáo phiên đáng ngờ — `POST /api/auctions/:id/report` (bidder)

Body: `{ "reason": "Giá tăng bất thường", "note": "Hai tài khoản đặt qua lại liên tục" }` — `reason` bắt buộc, tối đa 100 ký tự; `note` tuỳ chọn, tối đa 500 ký tự.

```json
// 201
{ "success": true, "data": { "reported": true, "flagCreated": true }, "error": null }
// 409 — mỗi người chỉ báo cáo một lần mỗi phiên
{ "success": false, "data": null, "error": { "code": "ALREADY_REPORTED", "message": "Bạn đã báo cáo phiên này rồi" } }
```

- Phiên đã có cờ `pending` (do luật gian lận hoặc báo cáo trước): báo cáo được thêm làm một dòng `flag_evidence` vào cờ đó (`flagCreated: false`).
- Chưa có cờ `pending`: tạo cờ mới trong `flagged_auctions` (`severity = 'low'`, `confidence = 30`, `reason = 'Người dùng báo cáo phiên đáng ngờ'`) kèm bằng chứng (`flagCreated: true`).
- Bằng chứng: `label = "Báo cáo từ người dùng #<accountId>"`, `value = "<reason> — <note>"`. Admin xem qua `GET /api/admin/flags` (BE2).
- Lỗi: `400 VALIDATION_ERROR` (thiếu/quá dài), `403 FORBIDDEN` (không phải bidder), `404 NOT_FOUND` (không có phiên), `409 ALREADY_REPORTED`.

## Đặt giá — `POST /api/bids` (bidder)

Body: **đúng một** trong hai dạng

```json
{ "auctionId": "12", "amount": 1300000 }     // giá tuyệt đối
{ "auctionId": "12", "increment": 50000 }    // = giá hiện tại + 50.000, giá hiện tại đọc sau khi khoá phiên
```

```json
// 201
{ "success": true, "error": null, "data": {
  "bidId": "89", "currentPrice": 1300000, "bidCount": 2, "endsAt": "2026-10-12T12:00:00.000Z", "extended": false } }
```

Quy tắc (kiểm tra trong một giao dịch, dòng phiên bị khoá `SELECT ... FOR UPDATE`):

- Phải đã đặt cọc → `403 DEPOSIT_REQUIRED`.
- Giá ≥ giá hiện tại + bước giá → `400 BID_TOO_LOW`.
- Không tự vượt giá chính mình → `409 ALREADY_LEADING`.
- Đặt trong 30 giây cuối: phiên còn đúng 30 giây (`extended: true`, `endsAt` mới).
- Gửi cả `amount` và `increment`, hoặc không gửi cái nào → `400 VALIDATION_ERROR`.
- Phiên hết giờ / huỷ → `409 AUCTION_ENDED`; đang tạm dừng → `409 AUCTION_PAUSED`.

Hai người cùng gửi `increment` một lúc: lần lượt nhận hai mức giá liên tiếp (không bao giờ trùng giá). Người bị vượt nhận
`notification:new` loại `outbid`; cả phòng nhận `auction:update` (xem `socket.md`).

## Ví — `/api/wallet` (bidder)

| Method | Đường dẫn | Body / query | Phản hồi `data` |
|---|---|---|---|
| GET | `/api/wallet` | | `{ "balance": 19880000, "held": 120000, "available": 19880000 }` |
| GET | `/api/wallet/transactions` | `limit`, `offset` | `{ "transactions": [ { "id", "kind", "amount", "relatedAuctionId", "auctionTitle", "balanceAfter", "createdAt" } ] }` |
| POST | `/api/wallet/topup` | `{ "amount": 500000 }` (1–100.000.000) | `201` `{ "transaction": {...}, "balance", "held", "available" }` |

- `balance` là tiền dùng được; `held` là cọc đang giữ (không nằm trong `balance`); `available` = `balance`.
- `kind`: `topup`, `deposit_hold`, `deposit_release`, `deposit_forfeit`, `payment`, `refund`. `amount` luôn dương, dấu do `kind` quyết định.
- Nạp tiền là cổng giả lập, luôn thành công.

## Đơn thắng — `/api/orders` (bidder)

### `GET /api/orders/mine`

`data`: `{ "orders": [ <order>, ... ] }`, mới nhất trước. Mỗi `<order>` như `GET /api/orders/:id`.

### `GET /api/orders/:id`

Chỉ đơn của chính mình; đơn của người khác hoặc không tồn tại → `404 NOT_FOUND`. Không có body.

```json
{ "success": true, "error": null, "data": {
  "id": "7", "auctionId": "12", "title": "Giày chạy bộ bản giới hạn, size 43",
  "finalPrice": 1300000, "fee": 65000, "shippingFee": 40000, "totalDue": 1405000,
  "depositApplied": 120000, "amountToPay": 1285000,
  "paymentStatus": "awaiting_payment", "paymentDeadline": "2026-10-13T12:00:05.000Z",
  "payoutStatus": "pending", "createdAt": "2026-10-12T12:00:05.000Z" } }
```

| Trường | Ý nghĩa |
|---|---|
| `fee` | 5% giá chốt, làm tròn nghìn |
| `totalDue` | `finalPrice + fee + shippingFee` |
| `depositApplied` / `amountToPay` | Cọc được trừ / số còn phải trả |
| `paymentStatus` | `awaiting_payment` → `paid`, hoặc `expired` khi quá 24 giờ (mất cọc) |
| `payoutStatus` | `pending` / `released` / `disputed` (BE2 cập nhật sau giao hàng, tranh chấp) |

Tiến trình kho / vận chuyển / địa chỉ giao hàng của đơn: `GET /api/orders/:id/tracking` (BE2).

### `POST /api/orders/:id/pay`

Body: `{ "method": "wallet" | "qr" | "card" }` (mặc định `wallet`). `wallet` trừ `amountToPay` từ ví; `qr` / `card` là cổng giả lập.

```json
{ "success": true, "error": null, "data": { "orderId": "7", "paymentStatus": "paid", "totalDue": 1405000, "balanceAfter": 18595000 } }
```

Lỗi: `402 INSUFFICIENT_FUNDS`, `409 ALREADY_PAID`, `409 PAYMENT_EXPIRED`, `404 NOT_FOUND`, `400 VALIDATION_ERROR` (sai `method`).

## Mã lỗi BE1

| HTTP | `code` | Khi nào |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Id sai định dạng, thiếu/sai trường |
| 400 | `BID_TOO_LOW` | Giá thấp hơn giá hiện tại + bước giá |
| 401 | `UNAUTHORIZED` | Thiếu / sai / hết hạn token |
| 402 | `INSUFFICIENT_FUNDS` | Ví không đủ tiền cọc hoặc thanh toán |
| 403 | `FORBIDDEN` | Sai vai trò |
| 403 | `ACCOUNT_SUSPENDED` | Tài khoản bị khoá |
| 403 | `DEPOSIT_REQUIRED` | Chưa đặt cọc mà đặt giá |
| 404 | `NOT_FOUND` | Không có phiên / đơn (hoặc đơn của người khác) |
| 409 | `ALREADY_JOINED`, `ALREADY_LEADING`, `ALREADY_REPORTED` | Thao tác lặp |
| 409 | `AUCTION_ENDED`, `AUCTION_PAUSED` | Phiên không nhận cọc / lượt giá |
| 409 | `ALREADY_PAID`, `PAYMENT_EXPIRED` | Thanh toán đơn |

## Hàm cho BE2 gọi (không tự ghi bảng `auctions` / số dư ví)

Chữ ký các hàm này đã chốt, không đổi.

```js
const engine = require('../services/auction_engine');
const wallet = require('../services/wallet_service');

// Thẩm định duyệt tin đăng -> sinh phiên (trong giao dịch của BE2)
await engine.createAuctionForListing(client, listingId);
// Admin chấm dứt phiên -> huỷ + hoàn cọc mọi người (gọi .emit() sau COMMIT)
const done = await engine.cancelAuction(client, auctionId, { reason }); /* COMMIT */ done.emit();
// Admin xử lý tranh chấp = refund
await wallet.refund(client, { bidderId, amount, auctionId });
// Giao dịch dùng chung
await engine.inTransaction(async (client) => { ... });
// Dữ liệu cho gợi ý giá AI / báo cáo
await require('../models/auction.model').listEndedHistory({ categoryCode: 'shoes' });
```

Tạm dừng / tiếp tục phiên: BE2 chỉ cần đổi `flagged_auctions.status` sang / khỏi `'paused'`; trigger
`flagged_auctions_sync_pause` (migration `006`) tự đóng băng và cộng bù đồng hồ (`auctions.paused_at`, `ends_at`),
và (migration `007`) báo cho server phát `auction:update` (`reason: 'paused' | 'resumed'`) vào phòng phiên.

Khoá tài khoản: sau khi COMMIT, gọi `require('../sockets').disconnectAccount(id, { kind: 'account' | 'ops', reason })`
để ngắt các kết nối socket đang mở (trả về `Promise<number>` số kết nối đã ngắt). Chi tiết: [`socket.md`](socket.md) mục 5.

`createNotification` / `emitNotification` thuộc BE2 (`services/notification_service.js`); BE1 gọi chúng cho
`outbid`, `win`, `refund`, `sold`, `warn`.

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm run db:seed` | Dữ liệu demo BE1 + BE2 (mật khẩu `123456`); chạy lại để gia hạn các phiên demo |
| `npm run test:be1` | Kiểm thử end-to-end BE1 trên DB dùng chung (tài khoản `test_be1_*`, tự dọn) — xem README |

Tài khoản demo: người mua `minhanh@gmail.com` (ví 20.000.000đ), người bán `long@sneakersg.vn`, Admin `admin@bidvibe.vn` (đăng nhập ops qua `/api/auth/ops/login`).
