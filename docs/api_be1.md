# API — Auction Core (BE1)

Mọi endpoint cần header `Authorization: Bearer <token>` (lấy từ `POST /api/auth/login`).
Response theo format chung `{ success, data, error }`. Tiền là VND (số nguyên).

## Kết nối từ app Flutter

| Chạy trên | Base URL |
|---|---|
| Android Emulator | `http://10.0.2.2:5000` |
| Điện thoại thật (cùng Wi-Fi) | `http://<IP máy tính>:5000` (mở cổng 5000 trên firewall) |
| Windows/Web/iOS Simulator | `http://localhost:5000` |

Server lắng nghe `0.0.0.0` nên emulator truy cập được. Android 9+ chặn HTTP thuần: thêm
`android:usesCleartextTraffic="true"` vào thẻ `<application>` của `AndroidManifest.xml` (và quyền `INTERNET`).

## Phiên đấu giá — `/api/auctions`

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/auctions?status=live\|ended\|joined&category=shoes\|elec\|antique&q=&sort=ending\|newest\|price_asc\|price_desc\|popular&limit=&offset=` | Danh sách phiên |
| GET | `/api/auctions/:id` | Chi tiết + 20 lượt đặt giá gần nhất (tên đã che: `A***`) |
| POST | `/api/auctions/:id/join` | (bidder) Đặt cọc 10% giá khởi điểm để được đặt giá |

Mỗi phiên có thêm thông tin riêng của người xem: `joined`, `leading`, `myBid`, `myDeposit`, `won`.

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

## Đặt giá — `/api/bids`

`POST /api/bids` (bidder) — body `{ "auctionId": "12", "amount": 1250000 }` hoặc `{ "auctionId": "12", "increment": 50000 }`.

Quy tắc: phải đã cọc; `amount >= giá hiện tại + bước giá`; không tự vượt giá chính mình; đặt trong 30 giây cuối thì
phiên được gia hạn còn đúng 30 giây (`extended: true`).

## Ví — `/api/wallet` (bidder)

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/wallet` | `{ balance, held, available }` |
| GET | `/api/wallet/transactions` | Lịch sử: `topup, deposit_hold, deposit_release, deposit_forfeit, payment, refund` |
| POST | `/api/wallet/topup` | `{ "amount": 500000 }` — giả lập cổng thanh toán, luôn thành công |

## Đơn thắng — `/api/orders` (bidder)

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/orders/mine` | Đơn của tôi: giá chốt, phí 5%, vận chuyển 40.000, cọc được trừ, hạn thanh toán |
| GET | `/api/orders/:id` | Chi tiết một đơn của tôi (cùng cấu trúc như trong `/mine`); đơn của người khác → `404` |
| POST | `/api/orders/:id/pay` | `{ "method": "wallet" \| "qr" \| "card" }` |

Quá 24 giờ chưa thanh toán: đơn `expired`, cọc bị tịch thu (job nền, 5 giây/lần).

## Mã lỗi hay gặp

`DEPOSIT_REQUIRED`, `ALREADY_JOINED`, `ALREADY_LEADING`, `BID_TOO_LOW`, `INSUFFICIENT_FUNDS` (402),
`AUCTION_ENDED`, `AUCTION_PAUSED`, `ALREADY_PAID`, `PAYMENT_EXPIRED`, `FORBIDDEN`, `UNAUTHORIZED`.

## Socket.io

Kết nối kèm JWT: `io(url, { auth: { token } })` — sai/thiếu token bị từ chối (`UNAUTHORIZED`).

| Hướng | Sự kiện | Dữ liệu |
|---|---|---|
| client → server | `auction:join` / `auction:leave` | `auctionId` (vào/rời phòng xem phiên) |
| server → client | `auction:update` | `{ auctionId, currentPrice, bidCount, endsAt, bid: { who, amount, at } }` |
| server → client | `auction:ended` | `{ auctionId, hasWinner, cancelled? }` |
| server → client | `notification:new` | `{ id, type, title, createdAt }` (bị vượt giá, thắng, hoàn cọc...) |

## Hàm cho BE2 gọi (không tự ghi bảng `auctions` / số dư ví)

```js
const engine = require('../services/auction_engine');
const wallet = require('../services/wallet_service');

// Thẩm định duyệt tin đăng -> sinh phiên (trong giao dịch của BE2)
await engine.createAuctionForListing(client, listingId);
// Admin chấm dứt phiên -> huỷ + hoàn cọc mọi người (gọi .emit() sau COMMIT)
const done = await engine.cancelAuction(client, auctionId); /* COMMIT */ done.emit();
// Admin xử lý tranh chấp = refund
await wallet.refund(client, { bidderId, amount, auctionId });
// Dữ liệu cho gợi ý giá AI / báo cáo
await require('../models/auction.model').listEndedHistory({ categoryCode: 'shoes' });
```

`createNotification(executor, { accountId, type, title })` hiện nằm ở `services/notification_service.js` — bản tối thiểu
BE1 dùng tạm; BE2 có thể thay thân hàm, giữ nguyên chữ ký.

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm run db:seed` | Tạo tài khoản + 6 phiên demo (mật khẩu `123456`); chạy lại để gia hạn phiên |
| `npm run test:be1` | Kiểm thử end-to-end 20 bước trên DB thật bằng dữ liệu tạm, tự dọn |

Tài khoản demo: người mua `minhanh@gmail.com` (ví 20.000.000đ), người bán `long@sneakersg.vn`, Admin `admin@bidvibe.vn` (đăng nhập ops qua `/api/auth/ops/login`).
