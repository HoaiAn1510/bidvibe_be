# Nối app Flutter với backend BidVibe — hướng dẫn nhanh

> Cập nhật: 2026-10-17.

Đọc một lần là nối được. Chi tiết từng endpoint ở [`api.md`](api.md), sự kiện real-time ở [`socket.md`](socket.md).

## 1. Chạy backend và địa chỉ gốc

Trên máy chạy backend (cần Node.js, file `.env` lấy từ người trong nhóm, **không** commit `.env`):

```bash
cd bidvibe_be
npm install
npm run db:migrate   # chỉ cần khi có migration mới
npm run dev          # server tại cổng PORT trong .env
curl http://localhost:5000/api/health   # {"success":true,"data":{"status":"ok",...}}
```

Cổng là biến `PORT` trong `.env` (`.env.example` đặt `5000`; không đặt thì `3000`). Server lắng nghe `0.0.0.0` và khi khởi động in sẵn các địa chỉ cần dùng:

```
BidVibe API đang chạy tại http://localhost:5000
  Android Emulator: http://10.0.2.2:5000
  Điện thoại thật (cùng Wi-Fi): http://192.168.1.23:5000
```

- `Cổng 5000 đang bị dùng (có thể đã chạy npm run dev ở cửa sổ khác)`: đã có một server đang chạy, dùng luôn server đó hoặc tắt nó trước.
- Tắt bằng Ctrl+C: server trả kết nối database ngay. Database Supabase dùng chung chỉ cho 15 kết nối cho cả nhóm. Người làm app tự chạy backend thì đặt `DB_POOL_MAX=2` trong `.env`.
- `GET /api/health` trả `db: "ok"` khi server nối được database. Gặp `503` / `db: "error"` thì do database chứ không do app.

| App chạy trên | Địa chỉ gốc REST (`baseUrl`) | Socket.io |
|---|---|---|
| Android Emulator | `http://10.0.2.2:5000` | cùng địa chỉ, không có `/api` |
| iOS Simulator, Windows, Web | `http://localhost:5000` | cùng địa chỉ |
| Điện thoại thật (cùng Wi-Fi với máy chạy backend) | `http://<IP LAN của máy chạy backend>:5000` | cùng địa chỉ |

Mọi đường dẫn REST bắt đầu bằng `/api`, ví dụ `http://10.0.2.2:5000/api/auctions`.

### Android Emulator

`10.0.2.2` là địa chỉ của máy tính nhìn từ trong emulator (`localhost` trong emulator là chính emulator). Cần đủ ba việc trong `android/app/src/main/AndroidManifest.xml`:

```xml
<manifest ...>
  <uses-permission android:name="android.permission.INTERNET"/>
  <application
      android:usesCleartextTraffic="true"
      ...>
```

- Android 9 trở lên chặn HTTP thuần, nên cần `usesCleartextTraffic="true"`.
- Nếu `<application>` đã có `android:networkSecurityConfig="@xml/network_security_config"`, Android **bỏ qua** `usesCleartextTraffic`. Khi đó phải cho phép HTTP tới `10.0.2.2` trong file cấu hình đó (thêm IP LAN nếu dùng điện thoại thật):

```xml
<!-- android/app/src/main/res/xml/network_security_config.xml -->
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
```

- Kiểm tra nhanh: mở Chrome trong emulator, vào `http://10.0.2.2:5000/api/health`. Thấy JSON là mạng ổn; nếu app vẫn lỗi thì do cấu hình app.
- Điện thoại thật: dùng địa chỉ "Điện thoại thật" server in ra (cùng Wi-Fi), mở cổng 5000 trên tường lửa Windows.
- Sửa `AndroidManifest.xml` xong phải chạy lại app từ đầu (`flutter run`), hot reload không áp dụng.

## 2. Tài khoản demo

Tạo bằng `npm run db:seed` (chạy lại nhiều lần không bị trùng; cũng gia hạn các phiên demo đang diễn ra). **Mật khẩu mọi tài khoản: `123456`.** Trước buổi demo xem thêm [Làm mới dữ liệu demo](#làm-mới-dữ-liệu-demo-trước-buổi-demo).

| Vai trò | Email | Đăng nhập bằng | Ghi chú |
|---|---|---|---|
| bidder | `minhanh@gmail.com` | `POST /api/auth/login` | Tài khoản demo chính, có đơn hàng và thông báo |
| bidder | `viet.tran@gmail.com`, `chau.le@outlook.com`, `hung.pham@gmail.com` | `POST /api/auth/login` | Ví được nạp 20.000.000đ khi seed lần đầu |
| bidder (bot) | `bot1@bidvibe.demo`, `bot2@bidvibe.demo`, `bot3@bidvibe.demo` | `POST /api/auth/login` | **Chỉ cho bot đấu giá** (`npm run demo:bidbot`), ví 50.000.000đ. Đừng đăng nhập app bằng các tài khoản này |
| seller | `long@sneakersg.vn` (Sneaker Sài Gòn) | `POST /api/auth/login` | Có phiên đang diễn ra và đơn đã bán |
| seller | `ha@phocoxua.vn`, `bao@retroaudio.vn`, `hai@retrocamera.vn`, `hoa@caonguyenxua.vn` | `POST /api/auth/login` | |
| appraiser | `ngoc.le@bidvibe.vn`, `khoa.tran@bidvibe.vn`, `huy.do@bidvibe.vn` | `POST /api/auth/ops/login` | Hàng chờ thẩm định có sẵn tin |
| warehouse | `anh.pham@bidvibe.vn`, `son.ngo@bidvibe.vn` | `POST /api/auth/ops/login` | Đơn kho ở đủ giai đoạn |
| warehouse | `yen.vu@bidvibe.vn` | `POST /api/auth/ops/login` | **Bị khoá**: dùng để thử lỗi `403 ACCOUNT_SUSPENDED` |
| admin | `admin@bidvibe.vn`, `trang.dang@bidvibe.vn`, `tuan.vo@bidvibe.vn` | `POST /api/auth/ops/login` | Có cờ gian lận và tranh chấp đang mở |

Database dùng chung cả nhóm: thao tác trên tài khoản demo (đặt giá, thanh toán...) sẽ đổi dữ liệu người khác cũng thấy. Muốn thử thoải mái thì tự đăng ký tài khoản mới.

**Đổi mật khẩu và sửa hồ sơ** (`POST /api/me/password`, `PATCH /api/me`) **chỉ thử trên tài khoản tự đăng ký.** Lỡ đổi mật khẩu tài khoản demo thì người chạy backend gõ `npm run db:seed`: mọi tài khoản demo về lại mật khẩu `123456` (dữ liệu và số dư giữ nguyên).

### Làm mới dữ liệu demo trước buổi demo

Phiên demo hết giờ dần theo thời gian thật. Khoảng 10 phút trước buổi demo, ở thư mục backend:

```bash
npm run db:seed:live -- --extend     # bảo đảm 9 phiên đang diễn ra, đẩy giờ kết thúc ra đủ thời lượng
npm run dev
```

- Danh sách phiên trong app (`GET /api/auctions?status=live`) sẽ có 9 phiên demo đủ 3 danh mục, đều có ảnh bìa (`coverUrl`) và 2 ảnh trong chi tiết. Một phiên kết thúc sau **khoảng 3 phút** để thử chống chốt phút chót (đặt giá trong 30 giây cuối thì phiên được gia hạn); muốn có lại phiên này thì chạy `npm run db:seed:live` lần nữa.
- Muốn thấy giá nhảy theo thời gian thực trên app (đăng nhập `minhanh@gmail.com`), mở thêm một terminal: `npm run demo:bidbot -- --auction <id> --only-outbid` (id lấy từ danh sách phiên). Bot chỉ dùng 3 tài khoản `bot*@bidvibe.demo`; chi tiết tuỳ chọn ở README.

## 3. Màn hình nào gọi endpoint nào

Ký hiệu: → gọi theo thứ tự; (socket) cần Socket.io.

| Màn hình | Gọi | Ghi chú |
|---|---|---|
| Đăng nhập | [`POST /api/auth/login`](api.md#post-apiauthlogin) (bidder / seller) hoặc [`POST /api/auth/ops/login`](api.md#post-apiauthopslogin) (thẩm định / kho / admin) → lưu `token`, `role` → [`GET /api/me`](api.md#get-apime) | `role` quyết định mở giao diện nào. Sau khi đăng nhập, mở Socket.io (socket) |
| Đăng ký | [`POST /api/auth/register`](api.md#post-apiauthregister) | Trả token luôn, không cần đăng nhập lại |
| Danh sách phiên | [`GET /api/categories`](api.md#get-apicategories), [`GET /api/auctions?status=live&sort=ending`](api.md#get-apiauctions) | Tab "Phiên của tôi": `status=joined`; nhãn theo `myState` ([gợi ý nhãn bên dưới](#nhãn-phiên-của-tôi-theo-mystate)) và hiện giá mình đặt cao nhất `myMaxBid` |
| Chi tiết phiên | [`GET /api/auctions/:id`](api.md#get-apiauctionsid) → (socket) `auction:join` | Đếm ngược theo `endsAt` và độ lệch giờ server (`serverTime`, [xem mục 6c](#6c-đồng-hồ-đếm-ngược-đúng-dù-điện-thoại-lệch-giờ)), khi tạm dừng theo `remainingSeconds`; nghe `auction:update`, `auction:ended`; rời màn → `auction:leave` |
| Đặt cọc | [`POST /api/auctions/:id/join`](api.md#post-apiauctionsidjoin) | Nút hiện khi `joined == false`. `402` → mở màn nạp ví |
| Đặt giá | [`POST /api/bids`](api.md#post-apibids) | Gửi `amount` **hoặc** `increment`. Giá mới về qua (socket) `auction:update` |
| Báo cáo phiên | [`POST /api/auctions/:id/report`](api.md#post-apiauctionsidreport) | |
| Ví | [`GET /api/wallet`](api.md#get-apiwallet) (có `joinBlockedUntil`: khác `null` thì hiện cảnh báo "Bạn bị tạm chặn tham gia phiên mới đến <ngày giờ>" và khoá nút đặt cọc), [`GET /api/wallet/transactions`](api.md#get-apiwallettransactions), [`POST /api/wallet/topup`](api.md#post-apiwallettopup) | |
| Đơn hàng (người mua) | [`GET /api/orders/mine`](api.md#get-apiordersmine) → [`GET /api/orders/:id`](api.md#get-apiordersid) → [`POST /api/orders/:id/pay`](api.md#post-apiordersidpay) | Đếm ngược tới `paymentDeadline` (24 giờ) |
| Chọn địa chỉ | [`GET /api/addresses`](api.md#get-apiaddresses) (chưa có thì [`POST /api/addresses`](api.md#post-apiaddresses)) → [`POST /api/orders/:id/shipping-address`](api.md#post-apiordersidshipping-address) | Nên làm ngay sau khi thắng / thanh toán; kho không gửi được đơn chưa có địa chỉ |
| Theo dõi giao hàng | [`GET /api/orders/:id/tracking`](api.md#get-apiordersidtracking) → [`POST /api/orders/:id/confirm-delivery`](api.md#post-apiordersidconfirm-delivery) | Hiện `stage`, `events`; nút "Đã nhận hàng" khi `stage == delivered`. Có vấn đề → [`POST /api/disputes`](api.md#post-apidisputes) |
| Thông báo | [`GET /api/notifications`](api.md#get-apinotifications), [`POST /api/notifications/:id/read`](api.md#post-apinotificationsidread), [`POST /api/notifications/read-all`](api.md#post-apinotificationsread-all) | Badge = `unreadCount`; thông báo mới qua (socket) `notification:new`. Bấm vào thông báo: mở màn theo `data` ([mục 5b](#5b-bấm-thông-báo-mở-đúng-màn)). Mở app / kéo để làm mới thì tải lại danh sách |
| Hồ sơ | [`GET /api/me`](api.md#get-apime) → [`PATCH /api/me`](api.md#patch-apime) (họ tên, số điện thoại, ảnh đại diện; Seller thêm tên gian hàng), [`POST /api/me/password`](api.md#post-apimepassword) | Ảnh đại diện: [tải ảnh](#5c-tải-ảnh) với `purpose=avatar` rồi gửi `avatarUrl` |
| Seller: tạo tin | [`GET /api/categories`](api.md#get-apicategories) → [`POST /api/ai/suggest-price`](api.md#post-apiaisuggest-price) → [`POST /api/listings`](api.md#post-apilistings) → [`POST /api/uploads/images`](api.md#post-apiuploadsimages) → [`POST /api/listings/:id/photos`](api.md#post-apilistingsidphotos) → [`POST /api/listings/:id/submit`](api.md#post-apilistingsidsubmit) | Ảnh trong máy: tải lên trước, gửi `urls` nhận được ([mục 5c](#5c-tải-ảnh)) |
| Seller: tin của tôi | [`GET /api/listings/mine`](api.md#get-apilistingsmine) → khi `draft` / `needs_info`: [`PATCH /api/listings/:id`](api.md#patch-apilistingsid), thêm / [xoá ảnh](api.md#delete-apilistingsidphotosphotoid), [`POST /api/listings/:id/resubmit`](api.md#post-apilistingsidresubmit) | Lý do ở `lastAppraisal.reason` |
| Seller: đơn đã bán | [`GET /api/orders/selling`](api.md#get-apiordersselling) → [`POST /api/orders/:id/ship-to-warehouse`](api.md#post-apiordersidship-to-warehouse) → [`GET /api/orders/:id/tracking`](api.md#get-apiordersidtracking) | Báo gửi kho khi `stage == awaiting_seller_shipment` |
| Hàng chờ thẩm định | [`GET /api/appraisals/queue`](api.md#get-apiappraisalsqueue) → [`GET /api/appraisals/:listingId`](api.md#get-apiappraisalslistingid) → [`POST /api/appraisals/:listingId/decision`](api.md#post-apiappraisalslistingiddecision) | Duyệt là mở phiên ngay |
| Kho | [`GET /api/warehouse/orders?stage=...`](api.md#get-apiwarehouseorders) → [`receive`](api.md#post-apiwarehouseordersidreceive) → [`inspect`](api.md#post-apiwarehouseordersidinspect) → [`pack`](api.md#post-apiwarehouseordersidpack) → [`ship`](api.md#post-apiwarehouseordersidship) → [`deliver`](api.md#post-apiwarehouseordersiddeliver) | Mỗi tab một `stage`. `ship` lỗi `ORDER_NO_ADDRESS` khi người mua chưa chọn địa chỉ |
| Tranh chấp | Người dùng: [`POST /api/disputes`](api.md#post-apidisputes), [`GET /api/disputes/mine`](api.md#get-apidisputesmine). Admin: [`GET /api/admin/disputes`](api.md#get-apiadmindisputes) → [`POST /api/admin/disputes/:id/resolve`](api.md#post-apiadmindisputesidresolve) | |
| Admin | [`GET /api/admin/dashboard`](api.md#get-apiadmindashboard), [`GET /api/admin/report/weekly`](api.md#get-apiadminreportweekly), [`GET /api/admin/flags`](api.md#get-apiadminflags) → [`POST /api/admin/flags/:id/action`](api.md#post-apiadminflagsidaction), [`/api/admin/ops-accounts`](api.md#get-apiadminops-accounts), [`/api/admin/accounts`](api.md#get-apiadminaccounts) | |
| Chatbot | [`POST /api/chat/messages`](api.md#post-apichatmessages), [`GET /api/chat/sessions/:id/messages`](api.md#get-apichatsessionsidmessages) | Giữ `sessionId` để hỏi tiếp |

Hiển thị trạng thái: dùng bảng [enum](api.md#18-giá-trị-trạng-thái-enum) để map giá trị ra nhãn tiếng Việt.

## 4. Token và xử lý lỗi

**Token**

- Lấy từ `data.token` khi đăng nhập / đăng ký; gửi mọi request qua header `Authorization: Bearer <token>`.
- Lưu bằng `flutter_secure_storage` (không lưu `shared_preferences` dạng thường). Lưu kèm `role`.
- Token hạn **7 ngày**, không có refresh token. Gặp `401 UNAUTHORIZED` → xoá token, về màn đăng nhập.
- Đăng xuất: xoá token phía app và ngắt socket (server không có API đăng xuất).

**Lỗi**: mọi phản hồi có `success`. Khi `success == false`:

- Hiện `error.message` cho người dùng (đã là tiếng Việt).
- Rẽ nhánh bằng `error.code`, không so sánh chuỗi `message`.

```dart
final body = jsonDecode(res.body) as Map<String, dynamic>;
if (body['success'] == true) return body['data'];
final err = body['error'] as Map<String, dynamic>;
switch (err['code']) {
  case 'UNAUTHORIZED':      await logout(); break;                 // 401: token hết hạn / sai
  case 'ACCOUNT_SUSPENDED': await logout(message: err['message']); break; // 403: tài khoản bị khoá
  case 'INSUFFICIENT_FUNDS': openTopUp(); break;                   // 402
  case 'DEPOSIT_REQUIRED':  openJoinDialog(); break;               // 403: đặt giá khi chưa cọc
  default: showSnackBar(err['message']);                            // 400 / 404 / 409 ...
}
```

Lỗi hay gặp:

| Tình huống | `code` (HTTP) | Nên làm |
|---|---|---|
| Token hết hạn / sai | `UNAUTHORIZED` (401) | Về màn đăng nhập |
| Tài khoản bị Admin khoá | `ACCOUNT_SUSPENDED` (403) | Đăng xuất, báo lý do |
| Gọi route sai vai trò | `FORBIDDEN` (403) | Lỗi giao diện: ẩn tính năng theo `role` |
| Thao tác sai thứ tự (ví dụ sửa tin đang chờ thẩm định) | `INVALID_STATE` (409) | Hiện `message`, tải lại dữ liệu |
| Đặt giá thấp | `BID_TOO_LOW` (400) | `message` có giá tối thiểu |
| Người hay bỏ đơn bị chặn đặt cọc phiên mới | `JOIN_BLOCKED` (403) | Hiện `message` (đã có ngày giờ được tham gia lại, giờ Việt Nam) |
| Đặt giá liên tiếp quá nhanh (dưới 1 giây sau lượt trước của cùng người) | `BID_TOO_FAST` (429) | Hiện `message`; khoá nút đặt giá khoảng 1 giây sau mỗi lần bấm để không dính lỗi này |
| Phiên đang tạm dừng | `AUCTION_PAUSED` (409) | Tải lại phiên, đồng hồ đứng yên |
| Kho gửi đơn chưa có địa chỉ | `ORDER_NO_ADDRESS` (409) | Màn kho: báo chờ người mua chọn địa chỉ |
| Không tìm thấy / không phải của mình | `NOT_FOUND` (404) | Quay lại danh sách |

Danh sách đầy đủ: [`api.md` mục 19](api.md#19-mã-lỗi-nghiệp-vụ).

## 5. Socket.io

- Gói: `socket_io_client`. Địa chỉ: **cùng địa chỉ gốc**, không có `/api`.
- Gửi token trong `auth` khi bắt tay. Token sai / tài khoản bị khoá → `connect_error` với `UNAUTHORIZED` / `ACCOUNT_SUSPENDED`.
- Sau khi kết nối, server tự cho vào phòng riêng (`user:{id}` để nhận thông báo). Muốn nhận cập nhật một phiên: gửi `auction:join` với id phiên; rời màn thì `auction:leave`. Mất kết nối rồi kết nối lại thì phải `auction:join` lại.
- Không đặt giá qua socket; đặt giá luôn qua [`POST /api/bids`](api.md#post-apibids).

| Sự kiện (server → app) | Khi nào | Làm gì |
|---|---|---|
| `auction:update` | `reason: "bid"` có lượt giá mới; `"paused"` / `"resumed"` Admin tạm dừng / tiếp tục; `"dev_time"` đổi giờ kết thúc bằng [API dev](#6b-test-nhanh-thắng-phiên-và-quá-hạn-thanh-toán) | Cập nhật giá, số lượt, `endsAt` / `remainingSeconds`, trạng thái dừng |
| `auction:viewers` | Có người vào / rời / ngắt kết nối phòng phiên: `{ auctionId, viewers }` | Cập nhật "N người đang xem". Đếm theo tài khoản và theo từng backend ([`socket.md`](socket.md)); số ban đầu lấy từ `viewers` của `GET /api/auctions/:id` |
| `auction:ended` | Phiên hết giờ (`hasWinner`) hoặc bị huỷ (`cancelled: true`) | Gọi lại [`GET /api/auctions/:id`](api.md#get-apiauctionsid) để biết `won`. Server đóng phiên trong vòng 5 giây sau giờ kết thúc; nếu đồng hồ về 0 mà chưa nhận sự kiện (mất mạng, chưa vào phòng) thì vài giây sau tự gọi lại `GET /api/auctions/:id` |
| `notification:new` | Có thông báo mới (`outbid`, `win`, `order`...) | Tăng badge, hiện snackbar |
| `account:disconnected` | Admin khoá tài khoản (ngay trước khi server ngắt) | Hiện `message`, đăng xuất, **không** tự kết nối lại |

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;
// showSnackBar, logout, reloadAuction: hàm của app, thay bằng cách làm của bạn.

IO.Socket connectSocket(String baseUrl, String token) {
  final socket = IO.io(baseUrl, IO.OptionBuilder()
      .setTransports(['websocket'])
      .setAuth({'token': token})
      .disableAutoConnect()
      .build());

  socket.onConnectError((err) => debugPrint('socket lỗi: $err')); // UNAUTHORIZED | ACCOUNT_SUSPENDED
  socket.on('notification:new', (n) => showSnackBar(n['title']));
  socket.on('account:disconnected', (d) { socket.dispose(); logout(message: d['message']); });
  socket.connect();
  return socket;
}

// Màn chi tiết phiên
void watchAuction(IO.Socket socket, String auctionId, void Function(Map) onUpdate) {
  socket.emit('auction:join', auctionId);
  socket.on('auction:update', (u) {
    if (u['auctionId'] != auctionId) return;
    onUpdate(u); // reason: bid | paused | resumed | dev_time; currentPrice, bidCount, endsAt, ...
  });
  socket.on('auction:ended', (e) { if (e['auctionId'] == auctionId) reloadAuction(); });
  socket.onReconnect((_) => socket.emit('auction:join', auctionId)); // vào lại phòng sau khi mất mạng
}

void leaveAuction(IO.Socket socket, String auctionId) {
  socket.emit('auction:leave', auctionId);
  socket.off('auction:update');
  socket.off('auction:ended');
}
```

Dữ liệu chi tiết của từng sự kiện: [`socket.md`](socket.md).

## 5b. Bấm thông báo mở đúng màn

Mỗi thông báo (cả trong `GET /api/notifications` lẫn sự kiện `notification:new`) có trường `data`: id liên quan dạng chuỗi (`auctionId`, `orderId`, `listingId`, `disputeId`) hoặc `null`. Điều hướng theo khoá trong `data`, không theo `type` (cùng một `type` có thể đến từ nhiều tình huống). Bảng khoá theo từng loại: [`api.md` mục 15](api.md#trường-data--mở-đúng-màn-khi-bấm-thông-báo).

```dart
// role: 'bidder' | 'seller' lưu lúc đăng nhập. Các hàm open...Screen là của app.
Future<void> onNotificationTap(Map<String, dynamic> n, String role) async {
  await api.post('/api/notifications/${n['id']}/read');           // đánh dấu đã đọc
  final data = (n['data'] as Map?)?.cast<String, dynamic>();
  if (data == null) return;                                        // thông báo cũ / loại chưa có data
  if (data['disputeId'] != null) return openMyDisputes(highlight: data['disputeId']);   // GET /api/disputes/mine
  if (data['orderId'] != null) {
    return role == 'seller'
        ? openOrderTracking(data['orderId'])                       // GET /api/orders/:id/tracking
        : openBuyerOrder(data['orderId']);                         // GET /api/orders/:id (+ /tracking)
  }
  if (data['listingId'] != null) return openMyListing(data['listingId']);              // GET /api/listings/mine
  if (data['auctionId'] != null) return openAuctionDetail(data['auctionId']);          // GET /api/auctions/:id
}
```

Các thông báo do phần đấu giá tạo cũng đã có `data` (`outbid` / `refund` hoàn cọc → `{ auctionId }`; `win` / `sold` → `{ auctionId, orderId }`; `address_reminder` / `warn` quá hạn thanh toán → `{ orderId, auctionId }`). Chỉ thông báo tạo trước migration `008` có `data: null`: với các thông báo này app chỉ đánh dấu đã đọc (hoặc tạm mở danh sách đơn / phiên của tôi).

## 5c. Tải ảnh

Ảnh chọn / chụp trên điện thoại đi qua hai bước:
1. Gửi file lên [`POST /api/uploads/images`](api.md#post-apiuploadsimages): `multipart/form-data`, trường `files`, 1–8 ảnh, mỗi ảnh tối đa 5 MB, chỉ JPEG / PNG / WEBP. Server trả `urls` theo đúng thứ tự gửi.
2. Gửi `urls` đó vào [`POST /api/listings/:id/photos`](api.md#post-apilistingsidphotos), hoặc dùng làm `avatarUrl` trong [`PATCH /api/me`](api.md#patch-apime) (tải với `?purpose=avatar`).

Gói cần: `http`, `image_picker`.

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

// Bước 1: tải ảnh lên, nhận URL public. purpose: 'listing' | 'avatar'.
Future<List<String>> uploadImages(String baseUrl, String token, List<XFile> images,
    {String purpose = 'listing'}) async {
  final req = http.MultipartRequest('POST', Uri.parse('$baseUrl/api/uploads/images?purpose=$purpose'))
    ..headers['Authorization'] = 'Bearer $token';
  for (final img in images) {
    req.files.add(await http.MultipartFile.fromPath('files', img.path)); // mọi ảnh cùng tên trường "files"
  }
  final res = await http.Response.fromStream(await req.send());
  final body = jsonDecode(res.body) as Map<String, dynamic>;
  if (body['success'] != true) {
    // INVALID_FILE_TYPE (400), FILE_TOO_LARGE (413), TOO_MANY_FILES (400),
    // UPLOAD_FAILED (502), UPLOAD_NOT_CONFIGURED (503): hiện body['error']['message']
    throw Exception(body['error']['message']);
  }
  return (body['data']['urls'] as List).cast<String>();
}

// Bước 2: Seller chọn ảnh trong máy rồi gắn vào tin (tin đang draft / needs_info).
Future<void> addPhotosFromGallery(String baseUrl, String token, String listingId) async {
  // Nén bớt ngay trên máy: ảnh camera thường > 5 MB.
  final picked = await ImagePicker().pickMultiImage(imageQuality: 85, maxWidth: 1920);
  if (picked.isEmpty) return;
  final urls = await uploadImages(baseUrl, token, picked.take(8).toList());
  final res = await http.post(Uri.parse('$baseUrl/api/listings/$listingId/photos'),
      headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
      body: jsonEncode({'urls': urls}));
  // 201: data là tin đăng với photos mới (photos[].id là chuỗi; xoá ảnh: DELETE /api/listings/:id/photos/:photoId)
}
```

- Chụp ảnh thay vì chọn: `ImagePicker().pickImage(source: ImageSource.camera, imageQuality: 85, maxWidth: 1920)`.
- `MultipartFile.fromPath` không dùng được trên Web. Bản Web dùng `MultipartFile.fromBytes('files', await img.readAsBytes(), filename: img.name)`.
- Server chưa cấu hình Storage thì trả `503 UPLOAD_NOT_CONFIGURED`. Lúc đó vẫn thêm ảnh được bằng URL có sẵn (`POST /api/listings/:id/photos` với `urls`).

## 6. Những điểm cần lưu ý

- **Id là chuỗi** (`"12"`), kể cả `photos[].id`. So sánh id nên ép về chuỗi.
- **Tiền là số nguyên VND**; tự định dạng hiển thị (`1.250.000 ₫`).
- **Đặt giá chỉ gửi một trong hai**: `amount` (giá tuyệt đối) **hoặc** `increment` (cộng thêm vào giá hiện tại). Gửi cả hai hoặc không gửi → `400`.
- **Chống chốt phút chót 30 giây**: đặt giá khi còn ≤ 30 giây thì phiên còn đúng 30 giây (`extended: true`); luôn cập nhật đồng hồ theo `endsAt` mới.
- **Đồng hồ khi tạm dừng**: dùng `remainingSeconds` của server; khi `paused` đồng hồ đứng yên, tiếp tục thì `endsAt` được cộng bù.
- **Cọc** = 10 phần trăm giá khởi điểm (`depositRequired`). Phải cọc trước khi đặt giá. Thua phiên tự hoàn cọc.
- **Thanh toán trong 24 giờ** sau khi thắng (`paymentDeadline`), quá hạn mất cọc. Số phải trả = `amountToPay` (đã trừ cọc).
- **Sửa địa chỉ có thể tạo `id` mới** (khi địa chỉ đã được một đơn đã gửi dùng): luôn lấy `id` từ phản hồi. Xoá địa chỉ đang gắn với đơn chưa gửi thì đơn mất địa chỉ, phải chọn lại.
- **Kho chỉ gửi đơn đã có địa chỉ**: thanh toán xong mà đơn chưa có địa chỉ thì backend gửi thông báo `address_reminder` (`data.orderId`). App nên mở thẳng màn chọn địa chỉ cho đơn đó.
- **Tự giải ngân sau 72 giờ** kể từ lúc giao nếu người mua không xác nhận và không mở tranh chấp.
- **Ảnh**: ảnh trong máy tải lên bằng [`POST /api/uploads/images`](#5c-tải-ảnh) rồi gửi URL; URL `http(s)` có sẵn thì gửi thẳng. Xoá ảnh khi tin còn `draft` / `needs_info`: `DELETE /api/listings/:id/photos/:photoId`.
- **Đồng hồ phiên về 0**: chờ vài giây rồi gọi lại `GET /api/auctions/:id`; server đóng phiên trong vòng 5 giây và có thể đã gia hạn nếu có người đặt giá phút chót.
- **Thông báo**: mỗi lần mở app hoặc kéo để làm mới thì tải lại `GET /api/notifications`. Socket chỉ đẩy thông báo lúc đang kết nối, nên thông báo đến khi app tắt sẽ không qua socket.
- **Thời gian** là ISO 8601 UTC; một số trường lồng trả dạng `+00:00`. Dùng `DateTime.parse(...).toLocal()`.
- Tài khoản `ops` (thẩm định / kho / admin) không có thông báo, ví, địa chỉ, chatbot.

## Nhãn "Phiên của tôi" theo `myState`

`GET /api/auctions` và `GET /api/auctions/:id` trả thêm `myState` và `myMaxBid` cho người mua đang đăng nhập (tính sẵn ở server, app không phải tự suy ra từ `leading` / `won` / `myBid`). Gợi ý nhãn:

| `myState` | Nhãn gợi ý | Màu gợi ý | Ghi chú |
|---|---|---|---|
| `leading` | Bạn đang dẫn đầu | Xanh | Phiên đang diễn ra |
| `outbid` | Bạn bị vượt giá | Đỏ | Có nút đặt giá lại; hiện `myMaxBid` là giá cao nhất của mình |
| `joined_no_bid` | Đã đặt cọc | Xanh dương | Chưa đặt giá; `myMaxBid` là `null` |
| `won` | Bạn đã thắng | Xanh đậm | Mở màn thanh toán / theo dõi đơn |
| `lost` | Không thắng | Xám | Cọc đã hoàn về ví (hoặc phiên bị huỷ) |
| `null` | (không nhãn) | | Chưa tham gia phiên này |

## 6b. Test nhanh thắng phiên và quá hạn thanh toán

Phiên thật chạy hàng giờ và đơn quá hạn sau 24 giờ, nên trước đây phải sửa tay database để test. Backend có sẵn hai API dev, mặc định **tắt**:

| API | Việc |
|---|---|
| [`POST /api/dev/auctions/:id/end-soon`](api.md#post-apidevauctionsidend-soon) | Phiên còn `seconds` giây nữa (5–3600, mặc định 10) rồi kết thúc như thật |
| [`POST /api/dev/orders/:id/expire-payment`](api.md#post-apidevordersidexpire-payment) | Đơn chưa thanh toán bị coi như quá 24 giờ, mất cọc như thật |

Cả hai chỉ **dịch đồng hồ**; việc đóng phiên, chọn người thắng, tạo đơn, hoàn cọc người thua, tịch thu cọc, gửi thông báo đều do server làm như bình thường (job nền 5 giây một lần).

**Bước 1. Bật trên máy bạn.** Trong `.env` của máy chạy backend thêm dòng (không commit `.env`):

```
DEV_TOOLS=true
```

Server (`npm run dev`) tự khởi động lại và in `[dev] DEV_TOOLS=true: đang mở /api/dev ...`. **Không bật trên máy chạy buổi demo.** Khi `NODE_ENV=production` hoặc không đặt `DEV_TOOLS`, `/api/dev/*` trả `404` như route không tồn tại.

**Bước 2. Thắng một phiên.**

1. Đăng nhập tài khoản Bidder, nạp ví đủ tiền cọc ([`POST /api/wallet/topup`](api.md#post-apiwallettopup)).
2. Mở phiên đang diễn ra, đặt cọc, đặt giá để **đang dẫn đầu** (người dẫn đầu khi hết giờ mới là người thắng).
3. Gọi `end-soon` với `id` của phiên (token của bất kỳ tài khoản nào):

```bash
curl -X POST http://localhost:5000/api/dev/auctions/<id phiên>/end-soon   -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"seconds":10}'
# {"success":true,"data":{"auctionId":"355","endsAt":"...","remainingSeconds":10},"error":null}
```

4. Màn chi tiết phiên (đang `auction:join`) nhận `auction:update` có `reason: "dev_time"` với `endsAt` / `remainingSeconds` mới: **đồng hồ tự nhảy về 10 giây**, không cần tải lại.
5. Hết giờ, trong vòng 5 giây app nhận `auction:ended` và `notification:new` loại `win`. `GET /api/orders/mine` có đơn mới (`paymentStatus: "awaiting_payment"`). Từ đây test màn thanh toán như bình thường ([`POST /api/orders/:id/pay`](api.md#post-apiordersidpay)).

**Bước 3. Test quá hạn thanh toán.** Với đơn vừa tạo (chưa thanh toán):

```bash
curl -X POST http://localhost:5000/api/dev/orders/<id đơn>/expire-payment -H "Authorization: Bearer $TOKEN"
# {"success":true,"data":{"orderId":"88","paymentDeadline":"..."},"error":null}
```

Trong vòng 5 giây: đơn thành `paymentStatus: "expired"`, cọc bị tịch thu (ví có giao dịch `deposit_forfeit`, `held` giảm), người mua nhận `notification:new` loại `warn`. Thanh toán đơn đó sau đó trả `409 PAYMENT_EXPIRED`.

Lỗi thường gặp: `404` ở `/api/dev/...` là chưa bật `DEV_TOOLS=true` (hoặc server chưa khởi động lại); `409 AUCTION_ENDED` / `AUCTION_PAUSED` là phiên đã kết thúc / đang tạm dừng; `409 ALREADY_PAID` là đơn đã trả tiền.

> Database dùng chung cả nhóm: `end-soon` đổi giờ kết thúc của phiên cho **mọi người đang xem phiên đó**. Chỉ dùng trên phiên bạn tự tạo hoặc tài khoản / dữ liệu thử của mình. Postman: thư mục "16 Công cụ dev" trong collection.

## 6c. Đồng hồ đếm ngược đúng dù điện thoại lệch giờ

Giờ trên điện thoại có thể lệch giờ server vài giây đến vài phút, nên đếm ngược kiểu `endsAt - DateTime.now()` sẽ sai. Server trả `serverTime` (ISO 8601 UTC) ở dưới. Đây là **giờ của database** (server đo độ lệch với database lúc khởi động và mỗi 60 giây), cùng đồng hồ với `endsAt` và với việc đóng phiên, nên đếm ngược theo `serverTime` khớp lúc server đóng phiên:

- [`GET /api/auctions`](api.md#get-apiauctions) và [`GET /api/auctions/:id`](api.md#get-apiauctionsid): cấp `data`, không lặp trong từng phiên;
- mọi sự kiện socket `auction:update` và `auction:ended` ([`socket.md`](socket.md)).

Cách dùng:

1. Mỗi lần nhận `serverTime` (REST hoặc socket): **lệch = serverTime − giờ máy lúc nhận**.
2. Đếm ngược theo **`endsAt − (giờ máy + lệch)`**.
3. Phiên đang tạm dừng (`paused: true`): đồng hồ đứng, hiển thị `remainingSeconds`, không dùng công thức trên.

```dart
Duration clockSkew = Duration.zero; // serverTime - giờ máy; cập nhật mỗi lần nhận serverTime

void syncClock(Map data) {
  final t = data['serverTime'];
  if (t is String) clockSkew = DateTime.parse(t).difference(DateTime.now().toUtc());
}

// Gọi cho phản hồi REST của danh sách / chi tiết phiên và cho mọi auction:update, auction:ended
// socket.on('auction:update', (u) { syncClock(u); ... });

Duration remaining(DateTime endsAt) {
  final now = DateTime.now().toUtc().add(clockSkew); // giờ server ước tính
  final left = endsAt.difference(now);
  return left.isNegative ? Duration.zero : left;
}
```

Lệch này chưa tính thời gian truyền mạng (dưới một giây trên Wi-Fi); chấp nhận được cho đồng hồ đếm ngược. Server vẫn là bên đóng phiên, nên khi về 0 hãy chờ `auction:ended` hoặc gọi lại `GET /api/auctions/:id` như ở [mục 6](#6-những-điểm-cần-lưu-ý).

## 7. Chạy thử luồng chính bằng curl

Chạy trong Git Bash / terminal có `curl` và `node`, server `npm run dev` đang chạy. Chuỗi lệnh dưới đã được chạy thật từ đầu tới cuối. Hàm `J` dùng Node đọc JSON (không cần `jq`).

> Trên Windows (Git Bash), `curl -d '...'` có chữ tiếng Việt có dấu sẽ gửi sai mã hoá. Ví dụ dưới chỉ dùng chữ không dấu; muốn gửi tiếng Việt thì ghi body ra file UTF-8 rồi dùng `--data-binary @body.json`. App Flutter gửi UTF-8 nên không bị ảnh hưởng.

```bash
BASE=http://localhost:5000
J() { node -pe "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); if(!r.success){console.error(JSON.stringify(r.error)); process.exit(1)} $1"; }
STAMP=$(date +%s)

# 1. Đăng ký người bán và người mua mới (token trả về ngay)
SELLER=$(curl -s -X POST $BASE/api/auth/register -H "Content-Type: application/json" \
  -d "{\"fullName\":\"Nguoi ban thu\",\"email\":\"test_be2_curl_${STAMP}_s@example.com\",\"password\":\"123456\",\"role\":\"seller\"}" | J "r.data.token")
BUYER=$(curl -s -X POST $BASE/api/auth/register -H "Content-Type: application/json" \
  -d "{\"fullName\":\"Nguoi mua thu\",\"email\":\"test_be2_curl_${STAMP}_b@example.com\",\"password\":\"123456\",\"role\":\"bidder\"}" | J "r.data.token")
APPRAISER=$(curl -s -X POST $BASE/api/auth/ops/login -H "Content-Type: application/json" \
  -d '{"email":"ngoc.le@bidvibe.vn","password":"123456"}' | J "r.data.token")

# 2. Người bán tạo tin, thêm ảnh, gửi thẩm định; thẩm định duyệt -> phiên mở (thời lượng 1 giờ)
LISTING_ID=$(curl -s -X POST $BASE/api/listings -H "Authorization: Bearer $SELLER" -H "Content-Type: application/json" \
  -d '{"title":"May anh film thu","categoryCode":"elec","startingPrice":1000000,"durationHours":1}' | J "r.data.id")
curl -s -X POST $BASE/api/listings/$LISTING_ID/photos -H "Authorization: Bearer $SELLER" -H "Content-Type: application/json" \
  -d '{"url":"https://picsum.photos/seed/try/800/600"}' | J "r.data.photos.length"          # 1
curl -s -X POST $BASE/api/listings/$LISTING_ID/submit -H "Authorization: Bearer $SELLER" | J "r.data.status"   # pending_appraisal
AUCTION_ID=$(curl -s -X POST $BASE/api/appraisals/$LISTING_ID/decision -H "Authorization: Bearer $APPRAISER" \
  -H "Content-Type: application/json" -d '{"decision":"approve"}' | J "r.data.auctionId")

# 3. Người mua nạp ví, đặt cọc, đặt giá
curl -s -X POST $BASE/api/wallet/topup -H "Authorization: Bearer $BUYER" -H "Content-Type: application/json" -d '{"amount":5000000}' | J "r.data.balance"   # 5000000
curl -s -X POST $BASE/api/auctions/$AUCTION_ID/join -H "Authorization: Bearer $BUYER" | J "r.data.deposit"   # 100000
curl -s -X POST $BASE/api/bids -H "Authorization: Bearer $BUYER" -H "Content-Type: application/json" \
  -d "{\"auctionId\":\"$AUCTION_ID\",\"increment\":50000}" | J "r.data.currentPrice"                         # 1050000
curl -s $BASE/api/auctions/$AUCTION_ID -H "Authorization: Bearer $BUYER" | J "r.data.leading+' '+r.data.remainingSeconds"

# 4. Chờ phiên kết thúc (1 giờ; server tự đóng phiên mỗi 5 giây), rồi lấy đơn thắng
ORDER_ID=$(curl -s $BASE/api/orders/mine -H "Authorization: Bearer $BUYER" | J "r.data.orders[0].id")

# 5. Thêm địa chỉ, thanh toán, chọn địa chỉ; người bán gửi kho
ADDRESS_ID=$(curl -s -X POST $BASE/api/addresses -H "Authorization: Bearer $BUYER" -H "Content-Type: application/json" \
  -d '{"recipientName":"Nguoi mua thu","phone":"0903 112 233","addressLine":"45 Vo Van Tan","district":"Quan 3","city":"TP.HCM"}' | J "r.data.id")
curl -s -X POST $BASE/api/orders/$ORDER_ID/pay -H "Authorization: Bearer $BUYER" -H "Content-Type: application/json" -d '{"method":"wallet"}' | J "r.data.paymentStatus"   # paid
curl -s -X POST $BASE/api/orders/$ORDER_ID/shipping-address -H "Authorization: Bearer $BUYER" -H "Content-Type: application/json" \
  -d "{\"addressId\":\"$ADDRESS_ID\"}" | J "r.data.shippingAddress.addressLine"
curl -s -X POST $BASE/api/orders/$ORDER_ID/ship-to-warehouse -H "Authorization: Bearer $SELLER" | J "r.data.stage"   # in_transit_to_warehouse

# 6. Kho đi hết các bước
WAREHOUSE=$(curl -s -X POST $BASE/api/auth/ops/login -H "Content-Type: application/json" \
  -d '{"email":"anh.pham@bidvibe.vn","password":"123456"}' | J "r.data.token")
curl -s -X POST $BASE/api/warehouse/orders/$ORDER_ID/receive -H "Authorization: Bearer $WAREHOUSE" | J "r.data.stage"   # inspecting
curl -s -X POST $BASE/api/warehouse/orders/$ORDER_ID/inspect -H "Authorization: Bearer $WAREHOUSE" -H "Content-Type: application/json" \
  -d '{"result":"match","notes":"Dat"}' | J "r.data.stage"                                                             # inspected
curl -s -X POST $BASE/api/warehouse/orders/$ORDER_ID/pack -H "Authorization: Bearer $WAREHOUSE" -H "Content-Type: application/json" -d '{}' | J "r.data.stage"   # packed
curl -s -X POST $BASE/api/warehouse/orders/$ORDER_ID/ship -H "Authorization: Bearer $WAREHOUSE" -H "Content-Type: application/json" \
  -d '{"carrier":"GHN Express","trackingCode":"GHN0000001"}' | J "r.data.stage"                                         # shipped
curl -s -X POST $BASE/api/warehouse/orders/$ORDER_ID/deliver -H "Authorization: Bearer $WAREHOUSE" | J "r.data.stage"   # delivered

# 7. Người mua xác nhận nhận hàng -> giải ngân
curl -s -X POST $BASE/api/orders/$ORDER_ID/confirm-delivery -H "Authorization: Bearer $BUYER" | J "r.data.stage+' '+r.data.payoutStatus"   # completed released
curl -s $BASE/api/orders/$ORDER_ID/tracking -H "Authorization: Bearer $BUYER" | J "r.data.events.map(e=>e.step).join(' -> ')"           # packing -> shipped -> delivered
```

Bước 4 phải chờ phiên hết giờ thật (ít nhất 1 giờ, vì `durationHours` tối thiểu là 1). Muốn thử nhanh luồng sau khi thắng, dùng tài khoản demo `minhanh@gmail.com` đã có sẵn đơn hàng ở nhiều giai đoạn (`GET /api/orders/mine`).

Tài khoản tạo ra ở trên có email `test_be2_curl_*`, nằm lại trong database dùng chung. Sau 1 giờ, dọn bằng `npm run test:clean` (xoá tài khoản `test_be2_*` cũ hơn 1 giờ và dữ liệu đi kèm; `npm run test:clean -- --dry-run` để xem trước). `npm run test:be2` không xoá các tài khoản này, vì mỗi lần chạy chỉ dọn dữ liệu của chính nó.
