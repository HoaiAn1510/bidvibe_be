# Socket.io — sự kiện real-time của BidVibe

Tài liệu cho người nối app Flutter. Nguồn sự thật là code: `src/sockets/auction_socket.js` (kết nối, phòng),
`src/services/auction_engine.js` (`auction:update`, `auction:ended`), `src/services/notification_service.js`
(`notification:new`). **Tên sự kiện đã chốt, không đổi.**

## 1. Kết nối và xác thực

Cùng địa chỉ với REST API (không có `/api`): emulator Android `http://10.0.2.2:5000`, máy thật `http://<IP máy tính>:5000`.

Token là JWT lấy từ `POST /api/auth/login` (hoặc `/api/auth/ops/login`), gửi trong `auth.token` lúc bắt tay:

```dart
// pubspec: socket_io_client
final socket = IO.io('http://10.0.2.2:5000', IO.OptionBuilder()
    .setTransports(['websocket'])
    .setAuth({'token': token})
    .disableAutoConnect()
    .build());
socket.onConnectError((err) => print(err)); // 'UNAUTHORIZED' khi thiếu / sai / hết hạn token
socket.connect();
```

- Cũng nhận header `Authorization: Bearer <token>` nếu client không gửi được `auth`.
- Thiếu, sai chữ ký hoặc hết hạn token: server từ chối kết nối với lỗi `UNAUTHORIZED` (`connect_error`).
- Token chỉ được kiểm tra **lúc kết nối**. Tài khoản bị khoá sau khi đã kết nối vẫn nhận sự kiện cho tới khi ngắt (xem mục 6).
- Đăng nhập lại / đổi token: ngắt socket cũ và kết nối lại bằng token mới.

## 2. Phòng (room)

| Phòng | Ai vào | Cách vào | Nhận sự kiện |
|---|---|---|---|
| `user:{accountId}` | Bidder / Seller (`kind = 'account'`) | **Tự động** khi kết nối | `notification:new` của chính mình |
| `auction:{auctionId}` | Bất kỳ ai đã kết nối | Gửi `auction:join` | `auction:update`, `auction:ended` của phiên đó |

Tài khoản nội bộ (Thẩm định / Kho / Admin) không có phòng `user:` vì không có thông báo. Socket tự rời mọi phòng khi ngắt;
sau khi kết nối lại phải gửi `auction:join` lại cho phiên đang xem.

## 3. Client gửi lên server

| Sự kiện | Dữ liệu | Ý nghĩa |
|---|---|---|
| `auction:join` | `auctionId` (chuỗi hoặc số, ví dụ `"12"`) | Vào phòng `auction:12` khi mở màn chi tiết phiên |
| `auction:leave` | `auctionId` | Rời phòng khi đóng màn chi tiết |

```dart
socket.emit('auction:join', auction.id);
// ...
socket.emit('auction:leave', auction.id);
```

Không có sự kiện nào để **đặt giá qua socket**: đặt giá luôn qua `POST /api/bids` (REST); socket chỉ dùng để nhận cập nhật.

## 4. Server gửi xuống client

Mọi sự kiện được đẩy **sau khi giao dịch DB đã COMMIT**, nên dữ liệu nhận được luôn là dữ liệu đã chốt. Tiền là số
nguyên VND, thời gian là chuỗi ISO 8601 (UTC). `auctionId` luôn là **chuỗi**.

### `auction:update` — có lượt giá mới (phòng `auction:{id}`)

```json
{
  "auctionId": "12",
  "currentPrice": 1250000,
  "bidCount": 6,
  "endsAt": "2026-10-10T08:30:00.000Z",
  "bid": { "who": "A***", "amount": 1250000, "at": "2026-10-10T08:29:41.120Z" }
}
```

- `endsAt` có thể **lùi về sau** khi đặt trong 30 giây cuối (chống chốt phút chót) — luôn cập nhật đồng hồ theo giá trị này.
- `bid.who` là tên đã che. Muốn biết lượt đó có phải của mình / mình có đang dẫn đầu không: gọi lại `GET /api/auctions/:id`
  (trả `leading`, `myBid`), hoặc so `currentPrice` với giá mình vừa đặt.

### `auction:ended` — phiên kết thúc (phòng `auction:{id}`)

```json
{ "auctionId": "12", "hasWinner": true }
{ "auctionId": "12", "hasWinner": false, "cancelled": true }
```

- Hết giờ (job nền 5 giây/lần): `hasWinner` cho biết có người thắng; không có `cancelled`.
- Admin chấm dứt phiên: `hasWinner: false, cancelled: true`.
- Ai thắng: gọi `GET /api/auctions/:id` (`won`) hoặc chờ `notification:new` loại `win`.

### `notification:new` — thông báo cá nhân (phòng `user:{accountId}`)

```json
{ "id": "57", "type": "outbid", "title": "Bạn đã bị vượt giá · Giày retro ... · 1.250.000đ", "createdAt": "2026-10-10T08:29:41.200Z" }
```

| `type` | Khi nào | Người nhận |
|---|---|---|
| `outbid` | Có người đặt giá cao hơn mình | Người vừa bị vượt |
| `win` | Phiên kết thúc, mình thắng — thanh toán trong 24 giờ | Người thắng |
| `refund` | Hoàn cọc (thua phiên / phiên bị huỷ) hoặc Admin hoàn tiền tranh chấp | Người mua |
| `sold` | Phiên của mình kết thúc có người thắng | Người bán |
| `warn` | Quá hạn thanh toán (mất cọc); phiên bị tạm dừng / chấm dứt | Người mua / người bán |
| `info`, `order`, `payout`, `dispute`, `listing_approved`, `listing_rejected`, `listing_needs_info` | Luồng sau bán, thẩm định, tranh chấp (BE2) | Xem `docs/api.md` |

Thông báo cũng được lưu DB: app offline lúc đó vẫn lấy được qua `GET /api/notifications` (BE2).
**Không có sự kiện socket riêng cho "bị vượt giá"**: dùng `notification:new` với `type = 'outbid'`.

## 5. Đối chiếu với tên trong tài liệu cũ

Một số bản bàn giao trước đây dùng tên khác. Code **không** phát các tên cũ; app phải nghe tên mới:

| Tên cũ (đừng dùng) | Tên đang dùng | Ghi chú |
|---|---|---|
| `auction:price_update` | `auction:update` | Dữ liệu ở mục 4 |
| `auction:outbid` | `notification:new` với `type = 'outbid'` | Gửi vào phòng `user:{id}`, không phải phòng phiên |
| `auction:join` / `auction:leave` | giữ nguyên | |
| `auction:ended` | giữ nguyên | |

## 6. Giới hạn hiện tại

- Không đẩy sự kiện khi Admin **tạm dừng / tiếp tục** phiên. Khi tạm dừng, đồng hồ đứng yên ở server (`paused`, `remainingSeconds`
  trong `GET /api/auctions/:id`); app nên tải lại chi tiết phiên khi nhận `notification:new` loại `warn` / `info`, hoặc khi
  đặt giá bị `409 AUCTION_PAUSED`.
- Tài khoản bị khoá sau khi đã kết nối chưa bị ngắt socket (REST thì đã chặn bằng `403 ACCOUNT_SUSPENDED`).
- Mỗi lần kết nối lại cần `auction:join` lại; bỏ lỡ sự kiện trong lúc mất mạng thì gọi lại `GET /api/auctions/:id`.
