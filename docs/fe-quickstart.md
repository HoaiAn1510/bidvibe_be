# Nối app Flutter với backend BidVibe — hướng dẫn nhanh

> Cập nhật: 2026-10-10.

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

Cổng là biến `PORT` trong `.env` (`.env.example` đặt `5000`; không đặt thì `3000`). Server lắng nghe `0.0.0.0`.

| App chạy trên | Địa chỉ gốc REST (`baseUrl`) | Socket.io |
|---|---|---|
| Android Emulator | `http://10.0.2.2:5000` | cùng địa chỉ, không có `/api` |
| iOS Simulator, Windows, Web | `http://localhost:5000` | cùng địa chỉ |
| Điện thoại thật (cùng Wi-Fi với máy chạy backend) | `http://<IP LAN của máy chạy backend>:5000` | cùng địa chỉ |

Mọi đường dẫn REST bắt đầu bằng `/api`, ví dụ `http://10.0.2.2:5000/api/auctions`.

Lưu ý khi chạy trên thiết bị:

- Android 9 trở lên chặn HTTP thuần: thêm `android:usesCleartextTraffic="true"` vào thẻ `<application>` trong `AndroidManifest.xml` và quyền `<uses-permission android:name="android.permission.INTERNET"/>`.
- Điện thoại thật: lấy IP LAN của máy chạy backend (`ipconfig` trên Windows), mở cổng 5000 trên tường lửa Windows.

## 2. Tài khoản demo

Tạo bằng `npm run db:seed` (chạy lại nhiều lần không bị trùng; cũng gia hạn các phiên demo đang diễn ra). **Mật khẩu mọi tài khoản: `123456`.**

| Vai trò | Email | Đăng nhập bằng | Ghi chú |
|---|---|---|---|
| bidder | `minhanh@gmail.com` | `POST /api/auth/login` | Tài khoản demo chính, có đơn hàng và thông báo |
| bidder | `viet.tran@gmail.com`, `chau.le@outlook.com`, `hung.pham@gmail.com` | `POST /api/auth/login` | Ví được nạp 20.000.000đ khi seed lần đầu |
| seller | `long@sneakersg.vn` (Sneaker Sài Gòn) | `POST /api/auth/login` | Có phiên đang diễn ra và đơn đã bán |
| seller | `ha@phocoxua.vn`, `bao@retroaudio.vn`, `hai@retrocamera.vn`, `hoa@caonguyenxua.vn` | `POST /api/auth/login` | |
| appraiser | `ngoc.le@bidvibe.vn`, `khoa.tran@bidvibe.vn`, `huy.do@bidvibe.vn` | `POST /api/auth/ops/login` | Hàng chờ thẩm định có sẵn tin |
| warehouse | `anh.pham@bidvibe.vn`, `son.ngo@bidvibe.vn` | `POST /api/auth/ops/login` | Đơn kho ở đủ giai đoạn |
| warehouse | `yen.vu@bidvibe.vn` | `POST /api/auth/ops/login` | **Bị khoá**: dùng để thử lỗi `403 ACCOUNT_SUSPENDED` |
| admin | `admin@bidvibe.vn`, `trang.dang@bidvibe.vn`, `tuan.vo@bidvibe.vn` | `POST /api/auth/ops/login` | Có cờ gian lận và tranh chấp đang mở |

Database dùng chung cả nhóm: thao tác trên tài khoản demo (đặt giá, thanh toán...) sẽ đổi dữ liệu người khác cũng thấy. Muốn thử thoải mái thì tự đăng ký tài khoản mới.

## 3. Màn hình nào gọi endpoint nào

Ký hiệu: → gọi theo thứ tự; (socket) cần Socket.io.

| Màn hình | Gọi | Ghi chú |
|---|---|---|
| Đăng nhập | [`POST /api/auth/login`](api.md#post-apiauthlogin) (bidder / seller) hoặc [`POST /api/auth/ops/login`](api.md#post-apiauthopslogin) (thẩm định / kho / admin) → lưu `token`, `role` → [`GET /api/me`](api.md#get-apime) | `role` quyết định mở giao diện nào. Sau khi đăng nhập, mở Socket.io (socket) |
| Đăng ký | [`POST /api/auth/register`](api.md#post-apiauthregister) | Trả token luôn, không cần đăng nhập lại |
| Danh sách phiên | [`GET /api/categories`](api.md#get-apicategories), [`GET /api/auctions?status=live&sort=ending`](api.md#get-apiauctions) | Tab "Phiên của tôi": `status=joined` |
| Chi tiết phiên | [`GET /api/auctions/:id`](api.md#get-apiauctionsid) → (socket) `auction:join` | Đếm ngược theo `remainingSeconds`; nghe `auction:update`, `auction:ended`; rời màn → `auction:leave` |
| Đặt cọc | [`POST /api/auctions/:id/join`](api.md#post-apiauctionsidjoin) | Nút hiện khi `joined == false`. `402` → mở màn nạp ví |
| Đặt giá | [`POST /api/bids`](api.md#post-apibids) | Gửi `amount` **hoặc** `increment`. Giá mới về qua (socket) `auction:update` |
| Báo cáo phiên | [`POST /api/auctions/:id/report`](api.md#post-apiauctionsidreport) | |
| Ví | [`GET /api/wallet`](api.md#get-apiwallet), [`GET /api/wallet/transactions`](api.md#get-apiwallettransactions), [`POST /api/wallet/topup`](api.md#post-apiwallettopup) | |
| Đơn hàng (người mua) | [`GET /api/orders/mine`](api.md#get-apiordersmine) → [`GET /api/orders/:id`](api.md#get-apiordersid) → [`POST /api/orders/:id/pay`](api.md#post-apiordersidpay) | Đếm ngược tới `paymentDeadline` (24 giờ) |
| Chọn địa chỉ | [`GET /api/addresses`](api.md#get-apiaddresses) (chưa có thì [`POST /api/addresses`](api.md#post-apiaddresses)) → [`POST /api/orders/:id/shipping-address`](api.md#post-apiordersidshipping-address) | Nên làm ngay sau khi thắng / thanh toán; kho không gửi được đơn chưa có địa chỉ |
| Theo dõi giao hàng | [`GET /api/orders/:id/tracking`](api.md#get-apiordersidtracking) → [`POST /api/orders/:id/confirm-delivery`](api.md#post-apiordersidconfirm-delivery) | Hiện `stage`, `events`; nút "Đã nhận hàng" khi `stage == delivered`. Có vấn đề → [`POST /api/disputes`](api.md#post-apidisputes) |
| Thông báo | [`GET /api/notifications`](api.md#get-apinotifications), [`POST /api/notifications/:id/read`](api.md#post-apinotificationsidread) | Badge = `unreadCount`; thông báo mới qua (socket) `notification:new` |
| Seller: tạo tin | [`GET /api/categories`](api.md#get-apicategories) → [`POST /api/ai/suggest-price`](api.md#post-apiaisuggest-price) → [`POST /api/listings`](api.md#post-apilistings) → [`POST /api/listings/:id/photos`](api.md#post-apilistingsidphotos) → [`POST /api/listings/:id/submit`](api.md#post-apilistingsidsubmit) | Ảnh: tải lên nơi khác trước, gửi URL |
| Seller: tin của tôi | [`GET /api/listings/mine`](api.md#get-apilistingsmine) → khi `needs_info`: [`PATCH /api/listings/:id`](api.md#patch-apilistingsid), thêm ảnh, [`POST /api/listings/:id/resubmit`](api.md#post-apilistingsidresubmit) | Lý do ở `lastAppraisal.reason` |
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
| `auction:update` | `reason: "bid"` có lượt giá mới; `"paused"` / `"resumed"` Admin tạm dừng / tiếp tục | Cập nhật giá, số lượt, `endsAt` / `remainingSeconds`, trạng thái dừng |
| `auction:ended` | Phiên hết giờ (`hasWinner`) hoặc bị huỷ (`cancelled: true`) | Gọi lại [`GET /api/auctions/:id`](api.md#get-apiauctionsid) để biết `won` |
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
    onUpdate(u); // reason: bid | paused | resumed; currentPrice, bidCount, endsAt, ...
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

## 6. Những điểm cần lưu ý

- **Id là chuỗi** (`"12"`). Ngoại lệ đã biết: `photos[].id` trong tin đăng của Seller là số. So sánh id nên ép về chuỗi.
- **Tiền là số nguyên VND**; tự định dạng hiển thị (`1.250.000 ₫`).
- **Đặt giá chỉ gửi một trong hai**: `amount` (giá tuyệt đối) **hoặc** `increment` (cộng thêm vào giá hiện tại). Gửi cả hai hoặc không gửi → `400`.
- **Chống chốt phút chót 30 giây**: đặt giá khi còn ≤ 30 giây thì phiên còn đúng 30 giây (`extended: true`); luôn cập nhật đồng hồ theo `endsAt` mới.
- **Đồng hồ khi tạm dừng**: dùng `remainingSeconds` của server; khi `paused` đồng hồ đứng yên, tiếp tục thì `endsAt` được cộng bù.
- **Cọc** = 10 phần trăm giá khởi điểm (`depositRequired`). Phải cọc trước khi đặt giá. Thua phiên tự hoàn cọc.
- **Thanh toán trong 24 giờ** sau khi thắng (`paymentDeadline`), quá hạn mất cọc. Số phải trả = `amountToPay` (đã trừ cọc).
- **Sửa địa chỉ có thể tạo `id` mới** (khi địa chỉ đã được một đơn đã gửi dùng): luôn lấy `id` từ phản hồi. Xoá địa chỉ đang gắn với đơn chưa gửi thì đơn mất địa chỉ, phải chọn lại.
- **Kho chỉ gửi đơn đã có địa chỉ**: nhắc người mua chọn địa chỉ sớm (backend chưa tự nhắc).
- **Tự giải ngân sau 72 giờ** kể từ lúc giao nếu người mua không xác nhận và không mở tranh chấp.
- **Ảnh chỉ lưu URL**: app tự tải ảnh lên dịch vụ khác rồi gửi URL `http(s)`. Chưa có API xoá ảnh.
- **Thời gian** là ISO 8601 UTC; một số trường lồng trả dạng `+00:00`. Dùng `DateTime.parse(...).toLocal()`.
- Tài khoản `ops` (thẩm định / kho / admin) không có thông báo, ví, địa chỉ, chatbot.

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

Tài khoản tạo ra ở trên có email `test_be2_curl_*`, nằm lại trong database dùng chung cho tới lần chạy `npm run test:be2` kế tiếp (lệnh này tự xoá mọi tài khoản `test_be2_*` và dữ liệu đi kèm).
