# Socket.io — sự kiện real-time của BidVibe

> Cập nhật: 2026-10-17. REST API xem [`api.md`](api.md); hướng dẫn nối nhanh xem [`fe-quickstart.md`](fe-quickstart.md).

Tài liệu cho người nối app Flutter. Nguồn sự thật là code: `src/sockets/auction_socket.js` (kết nối, phòng),
`src/sockets/index.js` (`disconnectAccount`), `src/sockets/pause_listener.js` (`auction:update` khi tạm dừng / tiếp tục, nghe sự kiện từ backend khác),
`src/sockets/broadcast.js` (phát cho mọi backend cùng database, [mục 8](#8-nhiều-backend-cùng-một-database)),
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
| `dev_time` | Chỉ khi server bật `DEV_TOOLS=true`: dev gọi `POST /api/dev/auctions/:id/end-soon` để rút ngắn phiên | như `paused` (`paused: false`) |

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

**Đổi giờ kết thúc để test** (`reason: "dev_time"`) — các trường như `paused` / `resumed`; `endsAt` và `remainingSeconds` là giá trị mới, đồng hồ cập nhật theo đó. App cũ chưa biết `reason` này vẫn chạy bình thường vì mọi trường cũ giữ nguyên. Hướng dẫn: [`fe-quickstart.md` mục 6b](fe-quickstart.md#6b-test-nhanh-thắng-phiên-và-quá-hạn-thanh-toán).

```json
{
  "auctionId": "12", "reason": "dev_time", "status": "active", "paused": false, "pausedAt": null,
  "endsAt": "2026-10-17T03:00:15.000Z", "remainingSeconds": 10, "currentPrice": 1250000, "bidCount": 6
}
```

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
    case 'dev_time': setEndsAt(DateTime.parse(u['endsAt'])); break; // chỉ khi dev bật DEV_TOOLS
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
{ "id": "2354", "type": "listing_approved", "title": "Tin đăng \"Máy nghe nhạc cassette 1988\" đã được duyệt, phiên đấu giá đã mở.",
  "createdAt": "2026-10-12T02:15:50.277Z", "data": { "auctionId": "841", "listingId": "849" } }
{ "id": "57", "type": "outbid", "title": "Bạn đã bị vượt giá · Giày retro ... · 1.250.000đ", "createdAt": "2026-10-10T08:29:41.200Z", "data": { "auctionId": "12" } }
```

`data` (từ migration `008`): id liên quan để app mở đúng màn khi bấm thông báo (`auctionId`, `orderId`, `listingId`, `disputeId`, giá trị là chuỗi), hoặc `null`. Trùng với trường `data` của `GET /api/notifications`. Bảng khoá theo từng loại: [`api.md` mục 15](api.md#trường-data--mở-đúng-màn-khi-bấm-thông-báo). Các loại do BE1 tạo đã truyền `data`: `outbid` `{ auctionId }`, `win` `{ auctionId, orderId }`, `address_reminder` `{ orderId, auctionId }`, `refund` hoàn cọc `{ auctionId }`, `sold` `{ auctionId, orderId }`, `warn` quá hạn thanh toán `{ orderId, auctionId }`. Chỉ thông báo tạo trước migration `008` mới có `data: null`.

| `type` | Khi nào | Người nhận |
|---|---|---|
| `outbid` | Có người đặt giá cao hơn mình | Người vừa bị vượt |
| `win` | Phiên kết thúc, mình thắng. `title` có mã đơn (`Đơn #<id>`), hạn thanh toán (24 giờ) và nhắc chọn địa chỉ giao hàng | Người thắng |
| `address_reminder` | Vừa thanh toán xong mà đơn chưa có địa chỉ giao hàng; một lần mỗi đơn. `title` bắt đầu bằng `Đơn #<id>` | Người mua |
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
| Việc làm | Gửi `account:disconnected` `{ code: 'ACCOUNT_SUSPENDED', message }` tới mọi kết nối của tài khoản ở server này, rồi đóng tất cả; đồng thời gửi lệnh qua kênh `bidvibe_events` để các backend khác cùng database làm y như vậy ([mục 8](#8-nhiều-backend-cùng-một-database)) |
| Trả về | `Promise<number>` — số kết nối đã đóng **ở riêng tiến trình này**; `0` nếu tài khoản không online ở đây hoặc server socket chưa khởi tạo (script, test không chạy server). Kết nối ở backend khác không được đếm |
| Lỗi | Không ném lỗi trong trường hợp bình thường |
| Gọi khi nào | **Sau COMMIT** việc đổi `status = 'suspended'`; gọi trước COMMIT thì kết nối lại ngay có thể vẫn lọt nếu giao dịch chưa chốt |

Không cần gọi khi **mở khoá**: tài khoản `active` kết nối lại bình thường. Kết nối của tài khoản ở backend khác cùng
database cũng bị đóng (qua `pg_notify`), không cần Redis adapter.

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
- Nhiều backend cùng một database: sự kiện và `disconnectAccount` tới được client nối vào backend khác qua `pg_notify` ([mục 8](#8-nhiều-backend-cùng-một-database)). Backend dùng database **khác** thì không liên thông.

## 8. Nhiều backend cùng một database

Cả nhóm mỗi người chạy một `npm run dev` riêng nhưng cùng trỏ một database Supabase. Socket.io chỉ phát cho socket nối
vào **chính tiến trình** tạo ra sự kiện, nên nếu không làm gì thêm thì đặt giá qua server A, người đang nối server B sẽ
không thấy. Backend xử lý việc này bằng `pg_notify` của Postgres, app **không phải làm gì**:

| Bước | Ở đâu |
|---|---|
| Mọi sự kiện (`auction:update` khi đặt giá, `auction:ended`, `notification:new`) đi qua `broadcast(room, event, payload)`: phát ngay cho socket của tiến trình này, đồng thời `pg_notify('bidvibe_events', { origin, room, event, payload })`. Luôn gọi **sau COMMIT**; NOTIFY lỗi chỉ ghi log, không làm hỏng request | `src/sockets/broadcast.js` |
| Mỗi tiến trình `LISTEN bidvibe_events` trên **cùng kết nối** LISTEN của `pause_listener` (không mở thêm kết nối). Tin có `origin` khác thì `io.to(room).emit(event, payload)`; tin do chính mình gửi (origin trùng) thì bỏ qua, nên không bị phát hai lần | `src/sockets/pause_listener.js` |
| `disconnectAccount` ngắt socket ở tiến trình này và gửi lệnh `disconnect` qua kênh: tiến trình khác gửi `account:disconnected` rồi ngắt socket của tài khoản đó | `src/sockets/index.js` |
| `auction:update` khi tạm dừng / tiếp tục vẫn đi kênh riêng `auction_pause` (trigger migration `007`), vốn đã tới mọi tiến trình | `src/sockets/pause_listener.js` |

- Payload của `pg_notify` phải dưới 8000 byte. Sự kiện lớn hơn (không có sự kiện nào hiện tại gần mức này) chỉ phát trong tiến trình tạo ra nó và ghi cảnh báo `[realtime]`.
- Mỗi tiến trình dùng **pool** (`DB_POOL_MAX`, mặc định 10) **+ 1 kết nối LISTEN**. Supabase session pooler cho 15 kết nối cho cả database.
- Kết nối LISTEN rớt thì tự nối lại sau 5 giây. Sự kiện từ backend khác trong lúc rớt bị lỡ; trạng thái thật vẫn đúng qua REST.
- Đã kiểm thử trong `test:be1`: khởi 2 server con, client nối server B, thao tác REST qua server A, B vẫn nhận đủ sự kiện.
