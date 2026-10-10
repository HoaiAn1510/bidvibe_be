# Socket.io — sự kiện real-time của BidVibe

> Cập nhật: 2026-10-10. REST API xem [`api.md`](api.md); hướng dẫn nối nhanh xem [`fe-quickstart.md`](fe-quickstart.md).

Tài liệu cho người nối app Flutter. Nguồn sự thật là code: `src/sockets/auction_socket.js` (kết nối, phòng),
`src/sockets/index.js` (`disconnectAccount`), `src/sockets/pause_listener.js` (`auction:update` khi tạm dừng / tiếp tục),
`src/services/auction_engine.js` (`auction:update` khi đặt giá, `auction:ended`), `src/services/notification_service.js`
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
socket.onConnectError((err) => print(err)); // 'UNAUTHORIZED' | 'ACCOUNT_SUSPENDED'
socket.on('account:disconnected', (data) {   // bị Admin khoá: hiện lý do, đăng xuất, KHÔNG tự kết nối lại
  showMessage(data['message']);
  logout();
});
socket.connect();
```

- Cũng nhận header `Authorization: Bearer <token>` nếu client không gửi được `auth`.
- Lỗi khi kết nối (`connect_error`, `err.message`):

  | Mã | Khi nào |
  |---|---|
  | `UNAUTHORIZED` | Thiếu token, sai chữ ký, hết hạn, hoặc tài khoản không còn tồn tại |
  | `ACCOUNT_SUSPENDED` | Tài khoản đang bị khoá (`status = 'suspended'`) — giống `403 ACCOUNT_SUSPENDED` của REST |
  | `INTERNAL_ERROR` | Lỗi DB khi kiểm tra tài khoản; thử lại sau |

- Trạng thái tài khoản được kiểm tra **mỗi lần kết nối**. Tài khoản bị khoá khi đang online thì bị server ngắt
  (xem `disconnectAccount`, mục 5) và không kết nối lại được.
- Đăng nhập lại / đổi token: ngắt socket cũ và kết nối lại bằng token mới.

## 2. Phòng (room)

| Phòng | Ai vào | Cách vào | Nhận sự kiện |
|---|---|---|---|
| `user:{accountId}` | Bidder / Seller (`kind = 'account'`) | **Tự động** khi kết nối | `notification:new` của chính mình, `account:disconnected` |
| `ops:{opsId}` | Thẩm định / Kho / Admin (`kind = 'ops'`) | **Tự động** khi kết nối | `account:disconnected` |
| `auction:{auctionId}` | Bất kỳ ai đã kết nối | Gửi `auction:join` | `auction:update`, `auction:ended` của phiên đó |

`accounts.id` và `ops_accounts.id` là hai dãy số riêng (có thể trùng số), nên phòng có tiền tố khác nhau. Tài khoản nội
bộ không có thông báo. Socket tự rời mọi phòng khi ngắt; sau khi kết nối lại phải gửi `auction:join` lại cho phiên đang xem.

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

### `auction:update` — phiên thay đổi (phòng `auction:{id}`)

Cùng một tên sự kiện cho hai loại thay đổi; phân biệt bằng trường `reason`:

| `reason` | Khi nào | Trường có mặt |
|---|---|---|
| `bid` | Có lượt giá mới | `auctionId`, `currentPrice`, `bidCount`, `endsAt`, `bid` |
| `paused` | Admin tạm dừng phiên để kiểm tra | `auctionId`, `status`, `paused`, `pausedAt`, `endsAt`, `remainingSeconds`, `currentPrice`, `bidCount` |
| `resumed` | Admin cho phiên chạy lại | như `paused` |

**Lượt giá mới** (`reason: "bid"`):

```json
{
  "auctionId": "12",
  "reason": "bid",
  "currentPrice": 1250000,
  "bidCount": 6,
  "endsAt": "2026-10-10T08:30:00.000Z",
  "bid": { "who": "A***", "amount": 1250000, "at": "2026-10-10T08:29:41.120Z" }
}
```

- `endsAt` có thể **lùi về sau** khi đặt trong 30 giây cuối (chống chốt phút chót) — luôn cập nhật đồng hồ theo giá trị này.
- `bid.who` là tên đã che. Muốn biết lượt đó có phải của mình / mình có đang dẫn đầu không: gọi lại `GET /api/auctions/:id`
  (trả `leading`, `myBid`), hoặc so `currentPrice` với giá mình vừa đặt.

**Tạm dừng** (`reason: "paused"`) — đồng hồ đứng yên, không nhận cọc / lượt giá (`409 AUCTION_PAUSED`):

```json
{
  "auctionId": "12", "reason": "paused", "status": "active", "paused": true,
  "pausedAt": "2026-10-10T08:10:00.000Z", "endsAt": "2026-10-10T08:30:00.000Z", "remainingSeconds": 1200,
  "currentPrice": 1250000, "bidCount": 6
}
```

**Tiếp tục** (`reason: "resumed"`) — `endsAt` mới đã được cộng đúng thời gian đã dừng:

```json
{
  "auctionId": "12", "reason": "resumed", "status": "active", "paused": false,
  "pausedAt": null, "endsAt": "2026-10-10T08:45:00.000Z", "remainingSeconds": 1200,
  "currentPrice": 1250000, "bidCount": 6
}
```

- Khi `paused: true`, hiển thị đếm ngược theo `remainingSeconds` (đứng yên), **không** theo `endsAt - now`.
- `status` là `auctions.status` (luôn `active` với hai loại này). Phiên bị Admin chấm dứt lúc đang dừng thì chỉ nhận
  `auction:ended` (`cancelled: true`), không có `resumed`.
- Sự kiện được phát dù ai đổi cờ tạm dừng (Admin qua BE2, hay máy chủ khác cùng database): trigger trong DB gửi
  `pg_notify('auction_pause')` lúc COMMIT, mỗi server BE đang chạy nghe kênh này và đẩy tới người đang xem.

Dart, xử lý chung:

```dart
socket.on('auction:update', (u) {
  switch (u['reason']) {
    case 'bid':     applyBid(u); break;
    case 'paused':  setPaused(true, remaining: u['remainingSeconds']); break;
    case 'resumed': setPaused(false, endsAt: DateTime.parse(u['endsAt'])); break;
  }
});
```

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

### `account:disconnected` — tài khoản bị khoá (phòng `user:{id}` / `ops:{id}`)

Gửi ngay trước khi server đóng mọi kết nối của tài khoản (xem `disconnectAccount`, mục 5):

```json
{ "code": "ACCOUNT_SUSPENDED", "message": "Tài khoản đã bị tạm khoá" }
```

Sau đó client nhận `disconnect` với lý do `io server disconnect`. Với lý do này Socket.io client **không tự kết nối lại**;
app nên hiện `message`, xoá token và về màn đăng nhập. Có kết nối lại cũng bị từ chối với `ACCOUNT_SUSPENDED`.

## 5. Hàm phía server: `disconnectAccount` (BE2 gọi khi khoá tài khoản)

```js
const { disconnectAccount } = require('../sockets');

// sau khi giao dịch khoá tài khoản đã COMMIT:
const n = await disconnectAccount(accountId);                        // Bidder / Seller (bảng accounts)
const m = await disconnectAccount(opsId, { kind: 'ops' });           // Thẩm định / Kho / Admin (ops_accounts)
await disconnectAccount(accountId, { reason: 'Vi phạm điều khoản' }); // lý do hiện cho người dùng
```

| | |
|---|---|
| Vị trí | `src/sockets/index.js`, xuất cùng `require('../sockets')` |
| Tham số 1 `accountId` | Id tài khoản (chuỗi hoặc số). `null` / `undefined` → không làm gì |
| Tham số 2 `options` (tuỳ chọn) | `kind`: `'account'` (mặc định, bảng `accounts`) hoặc `'ops'` (bảng `ops_accounts`) — bắt buộc truyền `'ops'` cho tài khoản nội bộ vì hai bảng có thể trùng id. `reason`: chuỗi hiện cho người dùng, mặc định `'Tài khoản đã bị tạm khoá'` |
| Việc làm | Gửi `account:disconnected` `{ code: 'ACCOUNT_SUSPENDED', message }` tới mọi kết nối của tài khoản, rồi đóng tất cả |
| Trả về | `Promise<number>` — số kết nối đã đóng; `0` nếu tài khoản không online hoặc server socket chưa khởi tạo (script, test không chạy server) |
| Lỗi | Không ném lỗi trong trường hợp bình thường |
| Gọi khi nào | **Sau COMMIT** việc đổi `status = 'suspended'`; gọi trước COMMIT thì kết nối lại ngay có thể vẫn lọt nếu giao dịch chưa chốt |

Không cần gọi khi **mở khoá**: tài khoản `active` kết nối lại bình thường. Hàm chỉ đóng kết nối trên **server đang chạy**
(chưa dùng Redis adapter); nếu nhiều máy chạy server cùng lúc, kết nối nằm ở máy khác không bị đóng ngay nhưng cũng không
kết nối lại được nữa.

## 6. Đối chiếu với tên trong tài liệu cũ

Một số bản bàn giao trước đây dùng tên khác. Code **không** phát các tên cũ; app phải nghe tên mới:

| Tên cũ (đừng dùng) | Tên đang dùng | Ghi chú |
|---|---|---|
| `auction:price_update` | `auction:update` với `reason = 'bid'` | Dữ liệu ở mục 4 |
| `auction:outbid` | `notification:new` với `type = 'outbid'` | Gửi vào phòng `user:{id}`, không phải phòng phiên |
| `auction:join` / `auction:leave` | giữ nguyên | |
| `auction:ended` | giữ nguyên | |

## 7. Giới hạn hiện tại

- Mỗi lần kết nối lại cần `auction:join` lại; bỏ lỡ sự kiện trong lúc mất mạng thì gọi lại `GET /api/auctions/:id`.
- `auction:update` khi tạm dừng / tiếp tục cần kết nối `LISTEN` tới Postgres (`sockets/pause_listener.js`, tự kết nối lại
  sau 5 giây nếu rớt). Trong lúc rớt, sự kiện bị lỡ; trạng thái thật vẫn đúng trong `GET /api/auctions/:id`.
- Ngắt tài khoản bị khoá chỉ có hiệu lực ngay lập tức nếu BE2 gọi `disconnectAccount` sau khi khoá (mục 5). Nếu chưa gọi,
  socket đang mở vẫn nhận sự kiện tới khi tự ngắt, nhưng không kết nối lại được và REST đã trả `403 ACCOUNT_SUSPENDED`.
- Chỉ một server: `disconnectAccount` và các sự kiện chỉ tới client nối vào chính server đó (chưa dùng Redis adapter).
