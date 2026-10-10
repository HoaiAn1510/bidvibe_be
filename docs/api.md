# API BidVibe

> Cập nhật: 2026-10-10. Ví dụ phản hồi lấy từ các lần gọi thật vào server `npm run dev` (dữ liệu demo + tài khoản tạm, đã che token và rút gọn mảng).

Một file duy nhất cho toàn bộ REST API của backend. Sự kiện real-time xem [`socket.md`](socket.md). Hướng dẫn nối nhanh cho app Flutter xem [`fe-quickstart.md`](fe-quickstart.md).

## Mục lục

1. [Quy ước chung](#1-quy-ước-chung)
2. [Vai trò và đăng nhập](#2-vai-trò-và-đăng-nhập)
3. [Xác thực và tài khoản](#3-xác-thực-và-tài-khoản)
4. [Địa chỉ giao hàng](#4-địa-chỉ-giao-hàng)
5. [Danh mục và tin đăng (Seller)](#5-danh-mục-và-tin-đăng-seller)
6. [Thẩm định](#6-thẩm-định)
7. [Phiên đấu giá](#7-phiên-đấu-giá)
8. [Cọc và đặt giá](#8-cọc-và-đặt-giá)
9. [Ví](#9-ví)
10. [Đơn hàng (Bidder và Seller)](#10-đơn-hàng-bidder-và-seller)
11. [Kho](#11-kho)
12. [Giao hàng và xác nhận](#12-giao-hàng-và-xác-nhận)
13. [Tranh chấp](#13-tranh-chấp)
14. [Cờ gian lận và Admin](#14-cờ-gian-lận-và-admin)
15. [Thông báo](#15-thông-báo)
16. [Chatbot và AI](#16-chatbot-và-ai)
17. [Tiện ích](#17-tiện-ích)
18. [Giá trị trạng thái (enum)](#18-giá-trị-trạng-thái-enum)
19. [Mã lỗi nghiệp vụ](#19-mã-lỗi-nghiệp-vụ)
20. [Bảng tra mọi endpoint](#20-bảng-tra-mọi-endpoint)

---

## 1. Quy ước chung

**Địa chỉ gốc**: `http://<host>:<PORT>`, mọi đường dẫn bắt đầu bằng `/api`. `PORT` lấy từ `.env` (`.env.example` đặt `5000`; nếu không đặt thì server dùng `3000`). Server lắng nghe `0.0.0.0`.

| Chạy app trên | Địa chỉ gốc |
|---|---|
| Android Emulator | `http://10.0.2.2:5000` |
| iOS Simulator, Windows, Web | `http://localhost:5000` |
| Điện thoại thật (cùng Wi-Fi) | `http://<IP máy chạy backend>:5000` |

**Xác thực**: mọi route trừ `GET /api/health` và `/api/auth/*` cần header `Authorization: Bearer <token>` (token lấy từ đăng nhập, hạn 7 ngày). Mỗi request server kiểm tra lại trạng thái tài khoản trong DB: tài khoản bị khoá nhận `403 ACCOUNT_SUSPENDED` dù token còn hạn.

**Định dạng phản hồi** (mọi endpoint, kể cả lỗi):

```json
{ "success": true,  "data": { ... }, "error": null }
{ "success": false, "data": null,    "error": { "code": "BID_TOO_LOW", "message": "Giá tối thiểu là 1.100.000đ" } }
```

- `error.message` là tiếng Việt, hiển thị thẳng cho người dùng được. `error.code` là hằng để app rẽ nhánh (xem [mục 19](#19-mã-lỗi-nghiệp-vụ)).
- Lỗi 5xx khi `NODE_ENV=production` chỉ trả message "Lỗi hệ thống".

**Kiểu dữ liệu**

- `id` là **chuỗi số** (`"12"`). Id trên đường dẫn sai định dạng → `400 VALIDATION_ERROR`. Trong body, các trường id (`auctionId`, `orderId`, `addressId`, `sessionId`) nhận cả số và chuỗi số. Ngoại lệ đã biết: `photos[].id` trong phản hồi tin đăng (mục 5) là **số**, còn ở mục 6 là chuỗi.
- Tiền là **số nguyên VND** (`1250000`), không có phần thập phân.
- Thời gian là chuỗi ISO 8601, UTC (`"2026-10-10T15:29:32.100Z"`; một số trường lồng trong JSON trả dạng `"...+00:00"`, vẫn là ISO 8601).

**Phân trang**: các danh sách nhận `?limit=` (1–100, mặc định 50) và `?offset=` (mặc định 0). Không trả tổng số bản ghi.

**Body**: JSON, header `Content-Type: application/json`. Body không phải JSON hợp lệ → `400 INVALID_JSON`.

## 2. Vai trò và đăng nhập

| Vai trò (`role`) | `kind` trong token | Bảng | Đăng nhập bằng | Tạo tài khoản |
|---|---|---|---|---|
| `bidder` (người mua) | `account` | `accounts` + `bidders` | [`POST /api/auth/login`](#post-apiauthlogin) | Tự đăng ký [`POST /api/auth/register`](#post-apiauthregister) |
| `seller` (người bán) | `account` | `accounts` + `sellers` | [`POST /api/auth/login`](#post-apiauthlogin) | Tự đăng ký |
| `appraiser` (thẩm định) | `ops` | `ops_accounts` | [`POST /api/auth/ops/login`](#post-apiauthopslogin) | Admin tạo ([mục 14](#post-apiadminops-accounts)) |
| `warehouse` (kho) | `ops` | `ops_accounts` | [`POST /api/auth/ops/login`](#post-apiauthopslogin) | Admin tạo |
| `admin` | `ops` | `ops_accounts` | [`POST /api/auth/ops/login`](#post-apiauthopslogin) | Admin tạo |

Một tài khoản `accounts` chỉ là `bidder` **hoặc** `seller`. Chỉ `bidder` có ví. Tài khoản `ops` không có thông báo, chatbot hay địa chỉ.

Route gọi sai vai trò → `403 FORBIDDEN`.

---

## 3. Xác thực và tài khoản

### `POST /api/auth/register`

Không cần đăng nhập. Tạo tài khoản Bidder hoặc Seller và trả token luôn (đã đăng nhập).

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `fullName` | string | có | ≤ 100 ký tự, không rỗng |
| `email` | string | có | đúng định dạng, không trùng |
| `password` | string | có | 6–72 ký tự |
| `role` | string | có | `bidder` hoặc `seller` |
| `phone` | string | không | ≤ 20 ký tự |
| `shopName` | string | không | ≤ 100 ký tự, chỉ dùng khi `seller` (mặc định = `fullName`) |

```json
// 201
{ "success": true, "error": null, "data": {
  "account": { "id": "167", "fullName": "Người bán Demo", "email": "seller@example.com", "phone": "0908 000 111", "avatarUrl": null, "status": "active" },
  "role": "seller",
  "token": "eyJhbGciOi..." } }
```

Lỗi: `400 VALIDATION_ERROR` (ví dụ "Email không đúng định dạng", "Mật khẩu tối thiểu 6 ký tự"), `409 EMAIL_TAKEN`.

### `POST /api/auth/login`

Không cần đăng nhập. Dành cho `bidder` / `seller`. Body: `{ "email": string, "password": string }`.

```json
// 200
{ "success": true, "error": null, "data": {
  "account": { "id": "10", "fullName": "Nguyễn Minh Anh", "email": "minhanh@gmail.com", "phone": "0903 112 233", "avatarUrl": null, "status": "active" },
  "role": "bidder",
  "token": "eyJhbGciOi..." } }
```

Lỗi: `400 VALIDATION_ERROR` (thiếu email / mật khẩu), `401 INVALID_CREDENTIALS`, `403 ACCOUNT_SUSPENDED`.

### `POST /api/auth/ops/login`

Không cần đăng nhập. Dành cho `appraiser` / `warehouse` / `admin`. Body như trên.

```json
// 200
{ "success": true, "error": null, "data": {
  "account": { "id": "3", "fullName": "Hoàng Gia Bảo", "email": "admin@bidvibe.vn", "status": "active" },
  "role": "admin",
  "token": "eyJhbGciOi..." } }
```

Lỗi: `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_SUSPENDED` (ví dụ `yen.vu@bidvibe.vn` trong dữ liệu demo).

### `GET /api/me`

Mọi vai trò. Hồ sơ của người đang đăng nhập.

```json
// 200 (bidder / seller)
{ "id": "10", "fullName": "Nguyễn Minh Anh", "email": "minhanh@gmail.com", "phone": "0903 112 233",
  "avatarUrl": null, "status": "active", "role": "bidder", "kind": "account" }
// 200 (ops)
{ "id": "3", "fullName": "Hoàng Gia Bảo", "email": "admin@bidvibe.vn", "role": "admin", "status": "active", "kind": "ops" }
```

Lỗi: `401 UNAUTHORIZED` ("Thiếu token xác thực", "Token không hợp lệ hoặc đã hết hạn", "Tài khoản không còn tồn tại"), `403 ACCOUNT_SUSPENDED`.

---

## 4. Địa chỉ giao hàng

Chỉ `bidder`. Địa chỉ của người khác (hoặc đã xoá) → `404 NOT_FOUND` ở mọi thao tác.

### `GET /api/addresses`

```json
// 200 — địa chỉ mặc định đứng đầu
{ "addresses": [ { "id": "7", "recipientName": "Nguyễn Minh Anh", "phone": "0903 112 233", "addressLine": "45 Võ Văn Tần",
  "ward": "Phường 6", "district": "Quận 3", "city": "TP.HCM", "isDefault": true, "createdAt": "2026-10-09T15:46:46.439Z" } ] }
```

### `POST /api/addresses`

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `recipientName` | string | có | ≤ 100 |
| `phone` | string | có | 9–15 chữ số; cho phép khoảng trắng, `+`, `-`, `.`, `()` |
| `addressLine` | string | có | ≤ 255 (số nhà, đường) |
| `city` | string | có | ≤ 100 (tỉnh / thành phố) |
| `ward` | string | không | ≤ 100 |
| `district` | string | không | ≤ 100 |
| `isDefault` | boolean | không | `true` để đặt làm mặc định |

Địa chỉ đầu tiên tự thành mặc định. Tối đa 10 địa chỉ mỗi tài khoản.

```json
// 201
{ "id": "47", "recipientName": "Người mua Một", "phone": "0903 112 233", "addressLine": "45 Võ Văn Tần",
  "ward": "Phường 6", "district": "Quận 3", "city": "TP.HCM", "isDefault": true, "createdAt": "2026-10-10T15:29:33.600Z" }
```

Lỗi: `400 VALIDATION_ERROR` (ví dụ "Số điện thoại không hợp lệ", "Tối đa 10 địa chỉ cho mỗi tài khoản").

### `PATCH /api/addresses/:id`

Gửi trường nào sửa trường đó (cùng ràng buộc như trên). Phản hồi `200` như `POST`.

**Lưu ý**: nếu địa chỉ đang được một đơn **đã được kho gửi đi** dùng, backend không sửa tại chỗ mà tạo **địa chỉ mới với `id` mới** (phản hồi trả `id` mới), đơn đã gửi giữ địa chỉ cũ, đơn chưa gửi tự chuyển sang bản mới. App phải dùng `id` trong phản hồi.

Lỗi: `400 VALIDATION_ERROR` ("Không có trường nào để cập nhật"), `404 NOT_FOUND`.

### `POST /api/addresses/:id/default`

Không có body. Phản hồi `200` là địa chỉ với `isDefault: true`. Lỗi: `404 NOT_FOUND`.

### `DELETE /api/addresses/:id`

Xoá mềm: đơn đã gửi vẫn đọc được địa chỉ cũ. Đơn **chưa gửi** đang dùng địa chỉ này bị bỏ gắn, người mua phải chọn lại. Xoá địa chỉ mặc định thì địa chỉ mới nhất còn lại thành mặc định.

```json
// 200
{ "id": "48", "deleted": true }
```

Lỗi: `404 NOT_FOUND`. Gắn địa chỉ vào đơn: xem [`POST /api/orders/:id/shipping-address`](#post-apiordersidshipping-address).

---

## 5. Danh mục và tin đăng (Seller)

### `GET /api/categories`

Mọi vai trò.

```json
// 200
{ "categories": [ { "code": "shoes", "name": "Giày" }, { "code": "elec", "name": "Điện tử" }, { "code": "antique", "name": "Đồ cổ" } ] }
```

### `POST /api/listings`

Chỉ `seller`. Tạo tin ở trạng thái `draft`.

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `title` | string | có | ≤ 200 |
| `categoryCode` | string | có | mã từ `GET /api/categories` |
| `startingPrice` | integer | có | 1.000 – 10.000.000.000 |
| `durationHours` | integer | có | 1 – 336 (thời lượng phiên sau khi duyệt) |
| `description` | string | không | ≤ 5000 |
| `condition` | string | không | ≤ 100 |
| `aiSuggestedPrice` | integer | không | 0 – 10.000.000.000 (thường lấy từ [gợi ý giá](#post-apiaisuggest-price)) |

```json
// 201
{ "id": "362", "title": "Máy nghe nhạc cassette 1988", "category": "elec", "description": "Còn chạy tốt", "condition": "Như mới",
  "startingPrice": 1000000, "aiSuggestedPrice": null, "durationHours": 24, "status": "draft",
  "createdAt": "2026-10-10T15:29:17.280Z", "photos": [], "lastAppraisal": null, "auction": null }
```

Mọi endpoint tin đăng trả cùng cấu trúc này:

| Trường | Ý nghĩa |
|---|---|
| `status` | Xem [enum tin đăng](#tin-đăng-listingsstatus) |
| `photos` | `[{ "id": 165, "url": "...", "orderIndex": 0 }]` (`id` là số) |
| `lastAppraisal` | `{ decision, reason, decidedAt }` của lần thẩm định gần nhất, để Seller biết vì sao bị từ chối / cần bổ sung |
| `auction` | `{ id, status, currentPrice, endsAt }` khi tin đã có phiên, ngược lại `null` |

Lỗi: `400 VALIDATION_ERROR` (ví dụ `Danh mục "xyz" không tồn tại`).

### `GET /api/listings/mine`

Chỉ `seller`. Query: `status` (một giá trị [enum tin đăng](#tin-đăng-listingsstatus)), `limit`, `offset`. Mới nhất trước.

```json
// 200
{ "listings": [ { "id": "35", "title": "Giày da Oxford thủ công, size 41", "category": "shoes", "status": "ended",
  "startingPrice": 1500000, "durationHours": 72, "photos": [ { "id": 36, "url": "https://picsum.photos/...", "orderIndex": 0 } ],
  "lastAppraisal": { "decision": "approve", "reason": null, "decidedAt": "2026-09-21T11:22:20.006+00:00" },
  "auction": { "id": "28", "status": "ended", "currentPrice": 2150000, "endsAt": "2026-09-24T13:22:20.006Z" }, "...": "..." } ] }
```

### `PATCH /api/listings/:id`

Chỉ `seller`, tin của mình, khi `draft` hoặc `needs_info`. Gửi trường nào sửa trường đó (các trường như `POST`, kể cả `categoryCode`). Phản hồi `200` là tin đăng.

Lỗi: `404 NOT_FOUND`, `409 INVALID_STATE` ("Không thể sửa khi tin đăng đang ở trạng thái "chờ thẩm định""), `400 VALIDATION_ERROR`.

### `POST /api/listings/:id/photos`

Chỉ `seller`, tin của mình, khi `draft` / `needs_info`. Body `{ "url": "https://..." }` hoặc `{ "urls": ["https://...", ...] }`; chỉ nhận `http(s)`; tối đa 10 ảnh mỗi tin. Ảnh chỉ lưu URL (app tự tải ảnh lên nơi khác). Chưa có API xoá ảnh.

Phản hồi `201` là tin đăng với `photos` mới. Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 INVALID_STATE`.

### `POST /api/listings/:id/submit`

Chỉ `seller`. `draft` → `pending_appraisal`. Không có body. Phản hồi `200` là tin đăng.

Lỗi: `400 PHOTOS_REQUIRED` ("Cần ít nhất một ảnh trước khi gửi thẩm định"), `404 NOT_FOUND`, `409 INVALID_STATE`.

### `POST /api/listings/:id/resubmit`

Chỉ `seller`. Nộp lại sau khi bị yêu cầu bổ sung: `needs_info` → `pending_appraisal`. Không có body. Phản hồi `200` là tin đăng (kèm `lastAppraisal` của lần yêu cầu bổ sung).

Lỗi: `400 PHOTOS_REQUIRED`, `404 NOT_FOUND`, `409 INVALID_STATE`.

---

## 6. Thẩm định

Chỉ `appraiser`.

### `GET /api/appraisals/queue`

Query: `status=pending_appraisal` (mặc định) hoặc `needs_info` (đang chờ người bán bổ sung), `limit`, `offset`. Cũ nhất trước.

```json
// 200
{ "items": [ { "listingId": "20", "title": "Chén trà men ngọc thời Nguyễn", "category": "antique", "startingPrice": 3500000,
  "aiSuggestedPrice": 3600000, "condition": "Nguyên vẹn", "durationHours": 72, "status": "pending_appraisal",
  "createdAt": "2026-10-08T13:22:01.509Z", "seller": { "id": "15", "storeName": "Phố Cổ Collectibles", "rating": 4.9 },
  "photoCount": 3, "rounds": 0, "lastDecidedAt": null } ] }
```

`rounds` = số lần đã quyết định trước đó (vòng yêu cầu bổ sung).

### `GET /api/appraisals/:listingId`

```json
// 200
{ "listingId": "362", "title": "Máy nghe nhạc cassette 1988", "description": "Còn chạy tốt, đủ dây sạc", "condition": "Như mới",
  "category": "elec", "startingPrice": 1000000, "aiSuggestedPrice": null, "durationHours": 24, "status": "pending_appraisal",
  "createdAt": "2026-10-10T15:29:17.280Z",
  "seller": { "id": "167", "storeName": "Shop Demo", "rating": null, "endedListings": 0 },
  "photos": [ { "id": "165", "url": "https://picsum.photos/seed/doc1/800/600", "orderIndex": 0 } ],
  "history": [ { "id": "123", "decision": "more_info", "reason": "Chụp thêm ảnh số seri", "decidedAt": "...", "appraiser": "Lê Thị Ngọc" } ] }
```

Lỗi: `404 NOT_FOUND`.

### `POST /api/appraisals/:listingId/decision`

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `decision` | string | có | `approve`, `reject`, `more_info` |
| `reason` | string | khi `reject` / `more_info` | ≤ 1000 |

Chỉ quyết định khi tin đang `pending_appraisal`. Mỗi quyết định thêm một dòng lịch sử, không sửa dòng cũ.

- `approve`: tin → `approved` → `live`, **phiên đấu giá mở ngay** (`auctionId` trong phản hồi).
- `reject`: tin → `rejected`. `more_info`: tin → `needs_info`.
- Seller nhận thông báo `listing_approved` / `listing_rejected` / `listing_needs_info`.

```json
// 201
{ "appraisalId": "123", "decidedAt": "2026-10-10T15:29:19.874Z", "listingId": "362",
  "decision": "more_info", "listingStatus": "needs_info", "auctionId": null }
// 201 (approve)
{ "...": "...", "decision": "approve", "listingStatus": "live", "auctionId": "355" }
```

Lỗi: `400 VALIDATION_ERROR` ("Lý do không được để trống"), `404 NOT_FOUND`, `409 INVALID_STATE` ("Không thể thẩm định khi tin đăng đang ở trạng thái "cần bổ sung"").

---

## 7. Phiên đấu giá

### `GET /api/auctions`

Mọi vai trò. Query (đều tuỳ chọn):

| Query | Giá trị |
|---|---|
| `status` | `live` (đang diễn ra), `ended` (kết thúc hoặc huỷ), `joined` (phiên mình đã đặt cọc) |
| `category` | `shoes`, `elec`, `antique` |
| `q` | tìm theo tiêu đề |
| `sort` | `ending` (mặc định), `newest`, `price_asc`, `price_desc`, `popular` |
| `limit`, `offset` | phân trang |

```json
// 200
{ "auctions": [ {
  "id": "10", "listingId": "10", "title": "Bình gốm men rạn thời Nguyễn, cao 32cm", "category": "antique",
  "description": "Men rạn tự nhiên, ...", "condition": "Nguyên vẹn, không sứt mẻ", "coverUrl": null,
  "seller": { "id": "15", "storeName": "Phố Cổ Collectibles", "rating": 4.9 },
  "startPrice": 4000000, "currentPrice": 4500000, "bidStep": 50000, "depositRequired": 400000, "bidCount": 4,
  "startsAt": "2026-10-05T14:52:47.955Z", "endsAt": "2026-10-10T19:21:59.508Z",
  "status": "active", "isLive": true, "paused": false, "pausedAt": null, "remainingSeconds": 13970,
  "terminated": false, "winnerId": null,
  "joined": false, "myDepositStatus": null, "myDeposit": 0, "myBid": 0, "leading": false, "won": false } ] }
```

| Trường | Ý nghĩa |
|---|---|
| `status` | [enum phiên](#phiên-auctionsstatus) |
| `isLive` | Đang nhận cọc và lượt giá (`active`, chưa hết giờ, không tạm dừng) |
| `paused`, `pausedAt` | Admin tạm dừng để kiểm tra. Đồng hồ **đứng yên** khi dừng; khi tiếp tục `endsAt` được cộng thêm đúng thời gian đã dừng |
| `remainingSeconds` | Giây còn lại do server tính (đứng yên khi `paused`). Dùng giá trị này để đếm ngược, không tự tính `endsAt - now` khi đang dừng |
| `depositRequired` | Tiền cọc = 10 phần trăm giá khởi điểm, làm tròn nghìn |
| `joined`, `myDepositStatus`, `myDeposit`, `myBid`, `leading`, `won` | Riêng của người đang xem (tài khoản `ops` luôn rỗng) |

### `GET /api/auctions/:id`

Mọi vai trò. Cùng cấu trúc như một phần tử ở trên, thêm `bids`: 20 lượt giá gần nhất (mới nhất trước), tên người đặt đã che.

```json
"bids": [ { "id": "23", "who": "V***", "amount": 4500000, "at": "2026-10-07T14:32:47.955Z", "me": false } ]
```

Lỗi: `404 NOT_FOUND`. Cập nhật giá trực tiếp: nghe Socket.io `auction:update` ([`socket.md`](socket.md)).

### `POST /api/auctions/:id/report`

Chỉ `bidder`. Báo cáo phiên đáng ngờ, mỗi người một lần mỗi phiên.

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `reason` | string | có | ≤ 100 |
| `note` | string | không | ≤ 500 |

```json
// 201 — flagCreated=false nghĩa là báo cáo được thêm vào cờ đang chờ có sẵn
{ "reported": true, "flagCreated": true }
```

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 ALREADY_REPORTED`.

---

## 8. Cọc và đặt giá

### `POST /api/auctions/:id/join`

Chỉ `bidder`. Không có body. Đặt cọc tham gia phiên: giữ `depositRequired` từ ví (`balance` → `held`). Chỉ khi đã cọc mới được đặt giá.

```json
// 201
{ "depositId": "388", "deposit": 100000, "balanceAfter": 4900000 }
```

Lỗi: `402 INSUFFICIENT_FUNDS`, `404 NOT_FOUND`, `409 ALREADY_JOINED`, `409 AUCTION_ENDED`, `409 AUCTION_PAUSED`.

Cọc được hoàn tự động khi thua phiên hoặc phiên bị huỷ; người thắng được trừ cọc vào số tiền thanh toán; quá hạn thanh toán 24 giờ thì mất cọc.

### `POST /api/bids`

Chỉ `bidder`. Body **đúng một** trong hai dạng:

```json
{ "auctionId": "355", "amount": 1100000 }     // giá tuyệt đối
{ "auctionId": "355", "increment": 50000 }    // = giá hiện tại + 50.000 (giá hiện tại đọc sau khi khoá phiên)
```

```json
// 201
{ "bidId": "664", "currentPrice": 1050000, "bidCount": 1, "endsAt": "2026-10-11T15:29:21.085Z", "extended": false }
```

Quy tắc:

- Phải đã đặt cọc → `403 DEPOSIT_REQUIRED`.
- Giá ≥ `currentPrice + bidStep` → nếu không: `400 BID_TOO_LOW` ("Giá tối thiểu là 1.100.000đ").
- Không tự vượt giá của chính mình → `409 ALREADY_LEADING`.
- Đặt trong **30 giây cuối**: phiên còn đúng 30 giây (`extended: true`, `endsAt` mới).
- Gửi cả `amount` và `increment`, hoặc không gửi cái nào → `400 VALIDATION_ERROR`.
- Phiên hết giờ / huỷ → `409 AUCTION_ENDED`; đang tạm dừng → `409 AUCTION_PAUSED`; không có phiên → `404 NOT_FOUND`.

Người bị vượt giá nhận thông báo `outbid`; mọi người trong phòng phiên nhận `auction:update` ([`socket.md`](socket.md)).

---

## 9. Ví

Chỉ `bidder`.

### `GET /api/wallet`

```json
// 200 — balance: tiền dùng được; held: cọc đang giữ (không nằm trong balance); available = balance
{ "balance": 19530000, "held": 0, "available": 19530000 }
```

### `GET /api/wallet/transactions`

Query `limit`, `offset`. Mới nhất trước.

```json
// 200
{ "transactions": [ { "id": "605", "kind": "deposit_forfeit", "amount": 200000, "relatedAuctionId": "20",
  "balanceAfter": 19530000, "createdAt": "2026-10-10T15:10:48.547Z", "auctionTitle": "Radio bóng đèn Philips 1960, vỏ gỗ óc chó" } ] }
```

`amount` luôn dương, chiều tiền do `kind` quyết định (xem [enum giao dịch ví](#giao-dịch-ví-wallet_transactionskind)). `balanceAfter` là `balance` sau giao dịch.

### `POST /api/wallet/topup`

Body `{ "amount": integer }` (1 – 100.000.000). Cổng thanh toán giả lập, luôn thành công.

```json
// 201
{ "transaction": { "id": "734", "kind": "topup", "amount": 5000000, "relatedAuctionId": null, "balanceAfter": 5000000,
  "createdAt": "2026-10-10T15:29:21.762Z" }, "balance": 5000000, "held": 0, "available": 5000000 }
```

Lỗi: `400 VALIDATION_ERROR` ("Số tiền nạp phải từ 1 đến 100000000 VND").

---

## 10. Đơn hàng (Bidder và Seller)

Đơn được tạo tự động khi phiên kết thúc có người thắng (`paymentStatus = awaiting_payment`, hạn thanh toán 24 giờ).

### `GET /api/orders/mine`

Chỉ `bidder`. Đơn thắng của tôi, mới nhất trước: `{ "orders": [ <đơn>, ... ] }`, mỗi `<đơn>` như dưới.

### `GET /api/orders/:id`

Chỉ `bidder`, đơn của mình (khác → `404 NOT_FOUND`).

```json
// 200
{ "id": "120", "auctionId": "355", "title": "Máy nghe nhạc cassette 1988",
  "finalPrice": 1200000, "fee": 60000, "shippingFee": 40000, "totalDue": 1300000,
  "depositApplied": 100000, "amountToPay": 1200000,
  "paymentStatus": "awaiting_payment", "paymentDeadline": "2026-10-11T15:29:32.100Z",
  "payoutStatus": "pending", "createdAt": "2026-10-10T15:29:32.100Z" }
```

`fee` = 5 phần trăm giá chốt (làm tròn nghìn); `totalDue` = `finalPrice + fee + shippingFee`; `amountToPay` = `totalDue - depositApplied`.

### `POST /api/orders/:id/pay`

Chỉ `bidder`. Body `{ "method": "wallet" | "qr" | "card" }` (mặc định `wallet`). `wallet` trừ `amountToPay` từ ví; `qr` / `card` là cổng giả lập, luôn thành công.

```json
// 200
{ "orderId": "120", "paymentStatus": "paid", "totalDue": 1300000, "balanceAfter": 3700000 }
```

Lỗi: `400 VALIDATION_ERROR` (sai `method`), `402 INSUFFICIENT_FUNDS`, `404 NOT_FOUND`, `409 ALREADY_PAID`, `409 PAYMENT_EXPIRED`.

### `POST /api/orders/:id/shipping-address`

Chỉ `bidder`, đơn của mình. Body `{ "addressId": "47" }` (địa chỉ của mình, chưa xoá). Chọn hoặc đổi địa chỉ giao hàng, được đổi bất kỳ lúc nào **trước khi kho gửi đi** (kể cả lúc chờ thanh toán). Kho không gửi được đơn chưa có địa chỉ.

Phản hồi `200` là [chi tiết đơn sau bán](#cấu-trúc-đơn-sau-bán) kèm `shippingAddress`.

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND` (đơn hoặc địa chỉ không phải của mình), `409 INVALID_STATE` (đơn đã huỷ do quá hạn thanh toán), `409 ALREADY_SHIPPED` ("Đơn đã được gửi đi, không thể đổi địa chỉ giao hàng").

### `GET /api/orders/selling`

Chỉ `seller`. Đơn đã bán của tôi, mới nhất trước. Query `stage` (xem [enum giai đoạn](#giai-đoạn-đơn-stage)), `limit`, `offset`.

```json
// 200
{ "orders": [ { "id": "56", "auctionId": "8", "title": "Giày retro cao cổ \"Chicago\" 1985 — size 42", "stage": "awaiting_payment",
  "paymentStatus": "awaiting_payment", "payoutStatus": "pending", "...": "xem cấu trúc đơn sau bán" } ] }
```

### `POST /api/orders/:id/ship-to-warehouse`

Chỉ `seller`, đơn của mình. Báo đã gửi hàng về kho BidVibe. Đơn phải `paid`, chưa báo gửi, không có tranh chấp. Không có body.

Phản hồi `200` là chi tiết đơn sau bán (`stage: in_transit_to_warehouse`, `warehouse.orderCode` dạng `BV-ddmmyy-<id>`). Người mua nhận thông báo.

Lỗi: `404 NOT_FOUND`, `409 INVALID_STATE` ("Đơn chưa được thanh toán, chưa thể gửi hàng"), `409 ALREADY_SHIPPED`, `409 DISPUTE_OPEN`.

### `GET /api/orders/:id/tracking`

`bidder` hoặc `seller` của đơn đó (khác → `404`). Chi tiết đơn sau bán; **chỉ người mua** thấy `shippingAddress`.

#### Cấu trúc đơn sau bán

Dùng cho `/selling`, `/ship-to-warehouse`, `/shipping-address`, `/confirm-delivery`, `/tracking` và mọi endpoint kho:

```json
{ "id": "120", "auctionId": "355", "title": "Máy nghe nhạc cassette 1988", "category": "elec", "finalPrice": 1200000,
  "paymentStatus": "paid", "paymentDeadline": "2026-10-11T15:29:32.100Z",
  "payoutStatus": "released", "payoutDeadline": "2026-10-13T15:29:42.029Z", "deliveredConfirmedAt": "2026-10-10T15:29:43.039Z",
  "stage": "completed",
  "seller": { "id": "167", "storeName": "Shop Demo" },
  "buyer": { "id": "168" },
  "warehouse": { "orderCode": "BV-101026-0120", "receivedAt": "2026-10-10T15:29:38.982Z", "inspectionResult": "match",
    "inspectionNotes": "Đạt, tình trạng Như mới", "inspectedBy": "Kho tạm" },
  "shipment": { "status": "delivered", "trackingCode": "GHN7290365512", "updatedAt": "2026-10-10T15:29:42.029Z" },
  "shippingAddress": { "id": "47", "recipientName": "Người mua Một", "phone": "0903 112 233", "addressLine": "45A Võ Văn Tần",
    "ward": "Phường 6", "district": "Quận 3", "city": "TP.HCM" },
  "createdAt": "2026-10-10T15:29:32.100Z",
  "events": [ { "step": "packing", "note": "Đóng hộp carton 2 lớp", "at": "2026-10-10T15:29:40.219Z" } ] }
```

| Trường | Có khi |
|---|---|
| `warehouse` | Seller đã báo gửi kho (trước đó `null`) |
| `shipment`, `events` | Kho đã đóng gói (trước đó `null` / `[]`) |
| `shippingAddress` | Chỉ trong phản hồi cho người mua và kho; `null` nếu người mua chưa chọn |
| `buyer.name`, `buyer.phone` | Chỉ trong phản hồi cho kho |
| `events` | Có trong phản hồi chi tiết một đơn, **không** có trong danh sách |

---

## 11. Kho

Chỉ `warehouse`. Mỗi bước khoá đơn trong một giao dịch; làm sai thứ tự → `409 INVALID_STATE`.

### `GET /api/warehouse/orders`

Đơn Seller đã báo gửi kho, cũ nhất trước. Query `stage` (xem [enum giai đoạn](#giai-đoạn-đơn-stage)), `limit`, `offset`. Mỗi phần tử là [đơn sau bán](#cấu-trúc-đơn-sau-bán) có `buyer.name`, `buyer.phone`, `shippingAddress`.

### `POST /api/warehouse/orders/:id/receive`

Không có body. Seller đã báo gửi, kho chưa nhận → ghi lúc nhận (`stage: inspecting`). Người mua nhận thông báo.

Lỗi: `404 NOT_FOUND`, `409 INVALID_STATE` ("Người bán chưa báo gửi hàng về kho", "Kho đã nhận hàng của đơn này").

### `POST /api/warehouse/orders/:id/inspect`

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `result` | string | có | `match` hoặc `mismatch` |
| `notes` | string | khi `mismatch` | ≤ 2000 |

`match` → `stage: inspected`. `mismatch` → tự mở tranh chấp nguồn kho, `payoutStatus: disputed`, `stage: inspection_failed`, hai bên nhận thông báo; đơn dừng tới khi Admin xử lý.

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 INVALID_STATE` ("Kho chưa nhận hàng, chưa thể kiểm", "Đơn này đã được kiểm").

### `POST /api/warehouse/orders/:id/pack`

Body `{ "notes": string? }` (≤ 500). Kiểm đạt, không có tranh chấp → `shipment.status: packing`, `stage: packed`.

Lỗi: `404 NOT_FOUND`, `409 INVALID_STATE` ("Chỉ đóng gói được đơn đã kiểm đạt", "Đơn này đã được đóng gói"), `409 DISPUTE_OPEN`.

### `POST /api/warehouse/orders/:id/ship`

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `carrier` | string | có | ≤ 100 (ví dụ `GHN Express`) |
| `trackingCode` | string | có | ≤ 100 |

`packing` → `shipped`. **Đơn phải đã có địa chỉ giao hàng.** Người mua nhận thông báo.

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 INVALID_STATE` ("Chỉ gửi đi được đơn đã đóng gói"), `409 DISPUTE_OPEN`, `409 ORDER_NO_ADDRESS` ("Người mua chưa chọn địa chỉ giao hàng cho đơn này, chưa thể gửi đi").

### `POST /api/warehouse/orders/:id/deliver`

Không có body. `shipped` → `delivered`; đặt `payoutDeadline` = bây giờ + 72 giờ. Người mua nhận thông báo nhắc xác nhận.

Lỗi: `404 NOT_FOUND`, `409 INVALID_STATE` ("Chỉ xác nhận giao được đơn đang vận chuyển").

---

## 12. Giao hàng và xác nhận

### `POST /api/orders/:id/confirm-delivery`

Chỉ `bidder`, đơn của mình. Không có body. Xác nhận đã nhận hàng → giải ngân cho Seller ngay (`payoutStatus: released`, `stage: completed`), Seller nhận thông báo `payout`.

Nếu người mua không xác nhận và không mở tranh chấp, hệ thống **tự giải ngân** khi quá `payoutDeadline` (giao + 72 giờ), cả hai bên nhận thông báo.

Phản hồi `200` là [đơn sau bán](#cấu-trúc-đơn-sau-bán).

Lỗi: `404 NOT_FOUND`, `409 NOT_DELIVERED` ("Đơn chưa được giao, chưa thể xác nhận"), `409 ALREADY_CONFIRMED`, `409 DISPUTE_OPEN`, `409 ALREADY_RELEASED`.

Tiến trình giao hàng: [`GET /api/orders/:id/tracking`](#get-apiordersidtracking).

---

## 13. Tranh chấp

### `POST /api/disputes`

`bidder` hoặc `seller` của đơn. Đơn phải `paid`, chưa giải ngân, chưa có tranh chấp đang mở.

| Trường | Kiểu | Bắt buộc | Ràng buộc |
|---|---|---|---|
| `orderId` | id | có | đơn của mình |
| `title` | string | có | ≤ 200 |
| `reason` | string | có | ≤ 2000 |

Đơn chuyển `payoutStatus: disputed` (dừng giải ngân), bên kia nhận thông báo `dispute`.

```json
// 201
{ "id": "38", "orderId": "122", "itemTitle": "Đồng hồ treo tường", "source": "bidder", "reporterId": "168",
  "title": "Đồng hồ chạy chậm", "status": "open", "escrowAmount": 1143000, "resolution": "none", "resolvedBy": null,
  "finalPrice": 1050000, "payoutStatus": "disputed",
  "buyer": { "id": "168", "name": "Người mua Một" }, "seller": { "id": "167", "storeName": "Shop Demo" },
  "timeline": [ { "note": "Người mua mở tranh chấp: Chậm 5 phút mỗi ngày", "at": "2026-10-10T15:30:08.523235+00:00" } ] }
```

`escrowAmount` = số người mua đã trả cho đơn. Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 INVALID_STATE` ("Chỉ mở tranh chấp cho đơn đã thanh toán"), `409 ALREADY_RELEASED`, `409 DISPUTE_OPEN`.

### `GET /api/disputes/mine`

`bidder` / `seller`. Tranh chấp trên các đơn của tôi: `{ "disputes": [ <tranh chấp>, ... ] }`.

### `GET /api/admin/disputes`

Chỉ `admin`. Query `status=open|resolved`, `limit`, `offset`. Tranh chấp đang mở đứng trước.

### `POST /api/admin/disputes/:id/resolve`

Chỉ `admin`. Body `{ "resolution": "refund" | "keep", "note": string? }` (≤ 2000).

- `refund`: hoàn `escrowAmount` về ví người mua (giao dịch ví `refund`), tin đăng → `cancelled`, `payoutStatus` giữ `disputed`.
- `keep`: giữ nguyên giao dịch, `payoutStatus` → `released` (nếu đơn không còn tranh chấp khác đang mở).

```json
// 200
{ "id": "37", "orderId": "121", "source": "warehouse", "reporterId": null, "status": "resolved", "resolution": "refund",
  "resolvedBy": "Admin tạm", "escrowAmount": 1143000, "payoutStatus": "disputed", "...": "..." }
```

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 ALREADY_RESOLVED`.

---

## 14. Cờ gian lận và Admin

Mọi route `/api/admin/*` chỉ `admin`.

### `GET /api/admin/dashboard`

```json
// 200
{ "auctions": { "live": 4, "endingIn24h": 2 }, "appraisal": { "pending": 4, "needsInfo": 1 },
  "orders": { "awaitingPayment": 2, "awaitingSellerShipment": 3, "inTransitToWarehouse": 0, "inspecting": 1, "outbound": 2, "deliveredAwaitingConfirm": 1 },
  "flags": { "open": 4, "paused": 0 }, "disputes": { "open": 3 },
  "users": { "bidders": 4, "sellers": 5, "ops": 9, "suspended": 1 }, "escrowHeld": 33739000 }
```

### `GET /api/admin/report/weekly`

7 ngày gần nhất, từ dữ liệu thật.

```json
// 200
{ "period": { "from": "2026-10-03T15:29:13.528Z", "to": "2026-10-10T15:29:13.528Z" },
  "auctions": { "ended": 8, "sold": 8, "cancelled": 0 }, "sales": { "orders": 8, "gmv": 28150000, "estimatedFees": 1409000 },
  "payments": { "paid": 5, "expired": 1 }, "newAccounts": { "bidder": 4, "seller": 5 },
  "appraisals": { "approve": 10, "reject": 1, "more_info": 1 }, "disputes": { "opened": 3, "resolved": 0 },
  "walletTopups": { "count": 4, "total": 80000000 }, "topCategories": [ { "code": "elec", "orders": 3, "gmv": 14500000 } ] }
```

### `GET /api/admin/flags`

Query `status` ([enum cờ](#cờ-gian-lận-flagged_auctionsstatus)), `limit`, `offset`. Cờ đang mở và nghiêm trọng đứng trước.

```json
// 200
{ "flags": [ { "id": "8", "auction": { "id": "9", "title": "Máy ảnh film rangefinder 1984, ...", "status": "ended",
  "currentPrice": 9400000, "endsAt": "2026-10-10T09:21:59.508Z", "bidCount": 3 },
  "severity": "high", "confidence": 87, "reason": "Đặt giá dồn dập theo nhịp đều",
  "aiExplanation": "Các lượt đặt giá cách nhau gần như đúng 60 giây, ...", "status": "pending",
  "evidence": [ { "label": "Độ lệch nhịp đặt giá", "value": "±2 giây" } ] } ] }
```

Cờ được tạo tự động bởi bộ phát hiện gian lận sau mỗi lượt giá, hoặc khi người dùng [báo cáo phiên](#post-apiauctionsidreport).

### `POST /api/admin/flags/:id/action`

Body `{ "action": "pause" | "verify" | "safe" | "terminate", "reason": string }` (`reason` bắt buộc khi `terminate`, ≤ 1000). Phản hồi `200` là cờ (cấu trúc như trên).

| `action` | Cờ → | Tác dụng lên phiên |
|---|---|---|
| `pause` | `paused` | Không nhận cọc / lượt giá, không tự đóng; **đồng hồ đứng yên**. Người xem nhận `auction:update` `reason: paused` |
| `verify` | `verify` | Đang xác minh; nếu phiên đang dừng thì chạy lại, `endsAt` cộng bù thời gian đã dừng |
| `safe` | `safe` | Đóng cờ; phiên chạy bình thường |
| `terminate` | `terminated` | Huỷ phiên, hoàn cọc mọi người, thông báo; người xem nhận `auction:ended` `cancelled: true` |

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 INVALID_STATE` ("Cờ này đã được xử lý xong" khi cờ đã `terminated` / `safe`; "Cờ đã ở trạng thái này"), `409 AUCTION_ENDED` (terminate phiên không còn diễn ra).

### `GET /api/admin/ops-accounts`

Query `role` (`appraiser`, `warehouse`, `admin`), `status` (`active`, `suspended`).

```json
// 200
{ "accounts": [ { "id": "2", "name": "Phạm Đức Anh", "email": "anh.pham@bidvibe.vn", "role": "warehouse",
  "status": "active", "weeklyLoad": 0, "hasPassword": true } ] }
```

### `POST /api/admin/ops-accounts`

Body `{ "name", "email", "role": "appraiser" | "warehouse" | "admin", "password" }` (cùng ràng buộc như đăng ký). Phản hồi `201` như một phần tử ở trên.

Lỗi: `400 VALIDATION_ERROR`, `409 EMAIL_TAKEN`.

### `PATCH /api/admin/ops-accounts/:id`

Body `{ "name"?, "role"?, "status"?: "active" | "suspended", "password"? }`. Phản hồi `200` như trên.

Khoá (`suspended`): mọi socket đang mở của tài khoản bị ngắt (xem dưới). Không được tự khoá hoặc tự bỏ quyền Admin của chính mình.

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 SELF_LOCKOUT`.

### `GET /api/admin/accounts`

Tài khoản Bidder / Seller. Query `role` (`bidder`, `seller`), `status`, `q` (tìm tên / email), `limit`, `offset`.

```json
// 200
{ "accounts": [ { "id": "26", "fullName": "Nông Thị Hoa", "email": "hoa@caonguyenxua.vn", "phone": "0916 440 297",
  "role": "seller", "storeName": "Cao Nguyên Xưa", "status": "active", "createdAt": "2026-10-09T13:22:01.509Z" } ] }
```

### `PATCH /api/admin/accounts/:id`

Body `{ "status": "active" | "suspended" }`.

```json
// 200
{ "id": "169", "fullName": "Người mua Hai", "email": "b2@example.com", "status": "suspended" }
```

Lỗi: `400 VALIDATION_ERROR`, `404 NOT_FOUND`.

**Khoá tài khoản** (cả hai loại) có hiệu lực ngay: REST trả `403 ACCOUNT_SUSPENDED`; mọi socket đang mở nhận `account:disconnected` `{ code: "ACCOUNT_SUSPENDED", message: "Tài khoản đã bị khoá" }` rồi bị ngắt; kết nối lại bị từ chối cho tới khi mở khoá ([`socket.md`](socket.md)).

---

## 15. Thông báo

Chỉ `bidder` / `seller` (tài khoản `ops` → `403 FORBIDDEN` "Tài khoản nội bộ không có thông báo").

### `GET /api/notifications`

Query `limit`, `offset`. Mới nhất trước.

```json
// 200
{ "notifications": [ { "id": "916", "type": "warn",
  "title": "Quá hạn thanh toán · Radio bóng đèn Philips 1960, vỏ gỗ óc chó. Cọc đã bị tịch thu và giao dịch bị huỷ.",
  "isRead": false, "createdAt": "2026-10-10T15:10:48.547Z" } ], "unreadCount": 4 }
```

Giá trị `type`: xem [enum thông báo](#thông-báo-notificationstype). Thông báo mới cũng được đẩy real-time qua Socket.io `notification:new`.

### `POST /api/notifications/:id/read`

Không có body.

```json
// 200
{ "id": "1213", "isRead": true }
```

Lỗi: `404 NOT_FOUND` (không phải thông báo của mình).

---

## 16. Chatbot và AI

### `POST /api/chat/messages`

`bidder` / `seller`. Body `{ "content": string (≤ 2000), "sessionId"?: id }` — không có `sessionId` thì mở phiên trò chuyện mới. Trả lời soạn sẵn theo từ khoá (cọc, đặt giá, thanh toán, giao hàng, giải ngân, tranh chấp, ví, đăng tin), chưa gọi mô hình AI.

```json
// 201
{ "sessionId": "16", "messages": [
  { "id": "61", "sender": "user", "content": "Đặt cọc như thế nào?", "createdAt": "2026-10-10T15:30:22.851Z" },
  { "id": "62", "sender": "bot", "content": "Để tham gia một phiên, bạn đặt cọc 10% giá khởi điểm (làm tròn nghìn) từ ví. Thua phiên thì cọc được hoàn ngay khi phiên kết thúc; thắng thì cọc được trừ vào số tiền thanh toán.", "createdAt": "2026-10-10T15:30:22.851Z" } ] }
```

Lỗi: `400 VALIDATION_ERROR`, `403 FORBIDDEN` (tài khoản `ops`), `404 NOT_FOUND` (`sessionId` không phải của mình).

### `GET /api/chat/sessions/:id/messages`

`bidder` / `seller`, phiên của mình. Trả `{ "sessionId", "messages": [...] }` theo thứ tự thời gian. Lỗi: `404 NOT_FOUND`.

### `POST /api/ai/suggest-price`

`seller` hoặc `appraiser`. Body `{ "categoryCode": string, "condition"?: string }`. Chưa dùng mô hình AI: từ 3 phiên cùng danh mục đã kết thúc trở lên thì gợi ý theo lịch sử (`basis: "history"`), ít hơn thì dùng khung giá soạn sẵn (`basis: "default"`). Tình trạng "như mới / chưa qua sử dụng" tăng giá gợi ý, "hư / hỏng" giảm.

```json
// 200
{ "suggestedStartingPrice": 2750000, "expectedFinalRange": [1788000, 5075000], "basis": "history", "sampleSize": 8,
  "explanation": "Dựa trên 8 phiên cùng danh mục đã kết thúc: giá khởi điểm phổ biến khoảng 2.750.000đ (đã điều chỉnh theo tình trạng món hàng). Đây là gợi ý tham khảo, chưa dùng mô hình AI." }
```

Lỗi: `400 VALIDATION_ERROR` (danh mục không tồn tại).

---

## 17. Tiện ích

### `GET /api/health`

Không cần đăng nhập. Kiểm tra server đang chạy.

```json
// 200
{ "success": true, "data": { "status": "ok", "uptime": 2.144922 }, "error": null }
```

Đường dẫn không tồn tại → `404 NOT_FOUND` ("Không tìm thấy route: GET /api/...").

---

## 18. Giá trị trạng thái (enum)

Lấy đúng từ `migrations/`. Cột "Hiển thị gợi ý" để app map ra nhãn.

#### Tin đăng (`listings.status`)

| Giá trị | Hiển thị gợi ý | Ý nghĩa |
|---|---|---|
| `draft` | Nháp | Seller đang soạn, chưa gửi |
| `pending_appraisal` | Chờ thẩm định | Đã gửi, chờ Thẩm định |
| `needs_info` | Cần bổ sung | Thẩm định yêu cầu bổ sung (`lastAppraisal.reason`) |
| `approved` | Đã duyệt | Chỉ tồn tại thoáng qua: duyệt xong chuyển ngay sang `live` |
| `rejected` | Bị từ chối | Thẩm định từ chối (`lastAppraisal.reason`) |
| `live` | Đang đấu giá | Có phiên đang diễn ra |
| `ended` | Đã kết thúc | Phiên kết thúc |
| `cancelled` | Đã huỷ | Phiên bị Admin chấm dứt, người thắng quá hạn thanh toán, hoặc Admin hoàn tiền tranh chấp |

#### Phiên (`auctions.status`)

| Giá trị | Hiển thị gợi ý | Ý nghĩa |
|---|---|---|
| `active` | Đang diễn ra | Còn nhận cọc / lượt giá (trừ khi `paused: true`) |
| `ended` | Đã kết thúc | Hết giờ; có `winnerId` nếu có người đặt giá |
| `cancelled` | Đã huỷ | Admin chấm dứt |

Tạm dừng không phải một giá trị `status`: xem trường `paused`.

#### Cọc (`myDepositStatus`, `auction_deposits.status`)

| Giá trị | Ý nghĩa |
|---|---|
| `held` | Đang giữ cọc |
| `released` | Đã hoàn (thua phiên / phiên bị huỷ) |
| `applied_to_payment` | Đã trừ vào thanh toán (người thắng) |
| `forfeited` | Mất cọc (quá hạn thanh toán 24 giờ) |

#### Đơn hàng — thanh toán (`paymentStatus`)

| Giá trị | Hiển thị gợi ý | Ý nghĩa |
|---|---|---|
| `awaiting_payment` | Chờ thanh toán | Trong 24 giờ kể từ lúc thắng |
| `paid` | Đã thanh toán | Tiền nằm trong ký quỹ nền tảng |
| `expired` | Quá hạn | Quá 24 giờ, mất cọc, giao dịch huỷ |

#### Đơn hàng — giải ngân (`payoutStatus`)

| Giá trị | Hiển thị gợi ý | Ý nghĩa |
|---|---|---|
| `pending` | Chờ giải ngân | Tiền đang giữ, chờ giao hàng / xác nhận |
| `released` | Đã giải ngân | Người mua xác nhận, tự giải ngân sau 72 giờ, hoặc Admin giữ nguyên giao dịch |
| `disputed` | Đang tranh chấp | Có tranh chấp; sau khi Admin hoàn tiền vẫn giữ giá trị này |

#### Giai đoạn đơn (`stage`)

Không lưu trong DB, server suy ra cho các endpoint đơn sau bán và kho.

| Giá trị | Hiển thị gợi ý |
|---|---|
| `awaiting_payment` | Chờ thanh toán |
| `payment_expired` | Quá hạn thanh toán |
| `awaiting_seller_shipment` | Chờ người bán gửi kho |
| `in_transit_to_warehouse` | Đang gửi về kho |
| `inspecting` | Kho đang kiểm |
| `inspection_failed` | Không khớp mô tả (tranh chấp) |
| `inspected` | Kiểm đạt, chờ đóng gói |
| `packed` | Đã đóng gói |
| `shipped` | Đang giao |
| `delivered` | Đã giao, chờ xác nhận |
| `completed` | Hoàn tất, đã giải ngân |

#### Vận chuyển (`shipment.status`)

| Giá trị | Ý nghĩa |
|---|---|
| `packing` | Đã đóng gói tại kho |
| `shipped` | Đã bàn giao đơn vị vận chuyển (`trackingCode`) |
| `delivered` | Đã giao |

`warehouse.inspectionResult`: `match` (khớp mô tả) / `mismatch` (không khớp) / `null` (chưa kiểm).

#### Tranh chấp

| Trường | Giá trị |
|---|---|
| `status` | `open` (đang mở), `resolved` (đã xử lý) |
| `resolution` | `none` (chưa xử lý), `refund` (hoàn tiền người mua), `keep` (giữ nguyên, giải ngân người bán) |
| `source` | `bidder` (người mua mở), `seller` (người bán mở), `warehouse` (kho mở khi kiểm không khớp, `reporterId: null`) |

#### Cờ gian lận (`flagged_auctions.status`)

| Giá trị | Hiển thị gợi ý | Ý nghĩa |
|---|---|---|
| `pending` | Chờ xử lý | Mới phát hiện / người dùng báo cáo |
| `paused` | Đang tạm dừng | Admin tạm dừng phiên |
| `verify` | Đang xác minh | Admin đang xác minh, phiên vẫn chạy |
| `safe` | An toàn | Đóng cờ |
| `terminated` | Đã chấm dứt | Phiên bị huỷ |

`severity`: `low`, `medium`, `high`. `confidence`: 0–100.

#### Tài khoản

| Trường | Giá trị |
|---|---|
| `status` (cả `accounts` và `ops_accounts`) | `active` (hoạt động), `suspended` (bị khoá) |
| `role` | `bidder`, `seller`, `appraiser`, `warehouse`, `admin` |
| `kind` | `account` (Bidder / Seller), `ops` (Thẩm định / Kho / Admin) |

#### Giao dịch ví (`wallet_transactions.kind`)

| Giá trị | Hiển thị gợi ý | `balance` | `held` |
|---|---|---|---|
| `topup` | Nạp tiền | + | |
| `deposit_hold` | Giữ cọc | − | + |
| `deposit_release` | Hoàn cọc | + | − |
| `deposit_forfeit` | Mất cọc | | − |
| `payment` | Thanh toán đơn | − phần còn lại (chỉ khi trả bằng ví) | − cọc |
| `refund` | Hoàn tiền tranh chấp | + | |

#### Thẩm định (`appraisals.decision`)

`approve` (duyệt), `reject` (từ chối), `more_info` (yêu cầu bổ sung).

#### Thông báo (`notifications.type`)

Không phải enum trong DB; các giá trị code đang dùng:

| `type` | Khi nào | Người nhận |
|---|---|---|
| `outbid` | Bị người khác vượt giá | Người mua |
| `win` | Thắng phiên, cần thanh toán trong 24 giờ | Người mua |
| `refund` | Hoàn cọc / hoàn tiền tranh chấp | Người mua |
| `sold` | Phiên của mình kết thúc có người thắng | Người bán |
| `warn` | Quá hạn thanh toán; phiên bị tạm dừng / chấm dứt | Người mua / người bán |
| `info` | Phiên chạy lại; tự giải ngân | Cả hai |
| `order` | Tiến trình gửi kho, kho nhận, gửi đi, đã giao | Người mua |
| `payout` | Đơn được giải ngân | Người bán |
| `dispute` | Có tranh chấp / kết quả tranh chấp | Cả hai |
| `listing_approved`, `listing_rejected`, `listing_needs_info` | Kết quả thẩm định | Người bán |

#### Chatbot (`messages[].sender`)

`user`, `bot`.

---

## 19. Mã lỗi nghiệp vụ

Gom từ mọi `AppError` trong code. "Gợi ý hiển thị" khi muốn khác `error.message`; còn lại hiển thị thẳng `error.message`.

| `code` | HTTP | Ý nghĩa | Gợi ý xử lý trên app |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | Thiếu / sai trường, sai định dạng, ngoài khoảng | Hiện `message` cạnh form |
| `INVALID_JSON` | 400 | Body không phải JSON | Lỗi lập trình, ghi log |
| `BID_TOO_LOW` | 400 | Giá thấp hơn giá hiện tại + bước giá | Hiện `message` (có giá tối thiểu), tải lại phiên |
| `PHOTOS_REQUIRED` | 400 | Gửi thẩm định khi chưa có ảnh | Chuyển tới bước thêm ảnh |
| `UNAUTHORIZED` | 401 | Thiếu / sai / hết hạn token, tài khoản đã bị xoá | Xoá token, về màn đăng nhập |
| `INVALID_CREDENTIALS` | 401 | Sai email hoặc mật khẩu | Hiện `message` ở form đăng nhập |
| `INSUFFICIENT_FUNDS` | 402 | Ví không đủ tiền cọc / thanh toán | Gợi ý nạp tiền ([ví](#post-apiwallettopup)) |
| `FORBIDDEN` | 403 | Sai vai trò, hoặc tài khoản `ops` dùng tính năng chỉ cho người dùng | Ẩn tính năng theo vai trò |
| `ACCOUNT_SUSPENDED` | 403 | Tài khoản bị khoá | Đăng xuất, báo "Tài khoản đã bị khoá" |
| `DEPOSIT_REQUIRED` | 403 | Đặt giá khi chưa cọc | Mở bước đặt cọc |
| `NOT_FOUND` | 404 | Không tồn tại **hoặc không thuộc về bạn**; route sai | Quay lại danh sách |
| `PAYLOAD_TOO_LARGE` | 413 | Body quá lớn | Lỗi lập trình |
| `ALREADY_JOINED` | 409 | Đã đặt cọc phiên này | Coi như thành công, tải lại phiên |
| `ALREADY_LEADING` | 409 | Đang dẫn đầu, không tự vượt giá mình | Hiện `message` |
| `ALREADY_REPORTED` | 409 | Đã báo cáo phiên này | Hiện `message` |
| `AUCTION_ENDED` | 409 | Phiên đã kết thúc / huỷ; hoặc chấm dứt phiên không còn diễn ra | Tải lại phiên |
| `AUCTION_PAUSED` | 409 | Phiên đang tạm dừng | Tải lại phiên (đồng hồ đứng) |
| `AUCTION_EXISTS` | 409 | Tin đăng đã có phiên | Hiếm gặp (duyệt hai lần) |
| `ALREADY_PAID` | 409 | Đơn đã thanh toán | Tải lại đơn |
| `PAYMENT_EXPIRED` | 409 | Quá hạn thanh toán 24 giờ | Báo đơn đã huỷ, mất cọc |
| `INVALID_STATE` | 409 | Thao tác sai thứ tự trạng thái | Hiện `message`, tải lại dữ liệu |
| `ALREADY_SHIPPED` | 409 | Seller đã báo gửi kho; hoặc đổi địa chỉ khi kho đã gửi | Tải lại đơn |
| `ORDER_NO_ADDRESS` | 409 | Kho gửi hàng khi người mua chưa chọn địa chỉ | (Màn kho) báo chờ người mua chọn địa chỉ |
| `DISPUTE_OPEN` | 409 | Đơn đang có tranh chấp | Hiện trạng thái "Đang tranh chấp" |
| `NOT_DELIVERED` | 409 | Xác nhận nhận hàng khi chưa giao | Hiện `message` |
| `ALREADY_CONFIRMED` | 409 | Đã xác nhận nhận hàng | Tải lại đơn |
| `ALREADY_RELEASED` | 409 | Đơn đã giải ngân | Tải lại đơn |
| `ALREADY_RESOLVED` | 409 | Tranh chấp đã xử lý | Tải lại danh sách |
| `EMAIL_TAKEN` | 409 | Email đã được dùng | Hiện `message` ở trường email |
| `SELF_LOCKOUT` | 409 | Admin tự khoá / tự bỏ quyền mình | Hiện `message` |
| `INTERNAL_ERROR` | 500 | Lỗi hệ thống | Thông báo chung, thử lại |
| `WALLET_INCONSISTENT` | 500 | Số dư ví không khớp (không nên xảy ra) | Thông báo chung |

Lỗi khi kết nối Socket.io (`connect_error`): `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `INTERNAL_ERROR` — xem [`socket.md`](socket.md).

---

## 20. Bảng tra mọi endpoint

Bảng này khớp 1-1 với route đăng ký trong `src/routes/` (kiểm tra bằng `npm run docs:check`).

| Method | Đường dẫn | Quyền | Mục |
|---|---|---|---|
| GET | `/api/health` | không cần đăng nhập | [17](#get-apihealth) |
| POST | `/api/auth/register` | không cần đăng nhập | [3](#post-apiauthregister) |
| POST | `/api/auth/login` | không cần đăng nhập | [3](#post-apiauthlogin) |
| POST | `/api/auth/ops/login` | không cần đăng nhập | [3](#post-apiauthopslogin) |
| GET | `/api/me` | mọi vai trò | [3](#get-apime) |
| GET | `/api/addresses` | bidder | [4](#get-apiaddresses) |
| POST | `/api/addresses` | bidder | [4](#post-apiaddresses) |
| PATCH | `/api/addresses/:id` | bidder | [4](#patch-apiaddressesid) |
| POST | `/api/addresses/:id/default` | bidder | [4](#post-apiaddressesiddefault) |
| DELETE | `/api/addresses/:id` | bidder | [4](#delete-apiaddressesid) |
| GET | `/api/categories` | mọi vai trò | [5](#get-apicategories) |
| POST | `/api/listings` | seller | [5](#post-apilistings) |
| GET | `/api/listings/mine` | seller | [5](#get-apilistingsmine) |
| PATCH | `/api/listings/:id` | seller | [5](#patch-apilistingsid) |
| POST | `/api/listings/:id/photos` | seller | [5](#post-apilistingsidphotos) |
| POST | `/api/listings/:id/submit` | seller | [5](#post-apilistingsidsubmit) |
| POST | `/api/listings/:id/resubmit` | seller | [5](#post-apilistingsidresubmit) |
| GET | `/api/appraisals/queue` | appraiser | [6](#get-apiappraisalsqueue) |
| GET | `/api/appraisals/:listingId` | appraiser | [6](#get-apiappraisalslistingid) |
| POST | `/api/appraisals/:listingId/decision` | appraiser | [6](#post-apiappraisalslistingiddecision) |
| GET | `/api/auctions` | mọi vai trò | [7](#get-apiauctions) |
| GET | `/api/auctions/:id` | mọi vai trò | [7](#get-apiauctionsid) |
| POST | `/api/auctions/:id/report` | bidder | [7](#post-apiauctionsidreport) |
| POST | `/api/auctions/:id/join` | bidder | [8](#post-apiauctionsidjoin) |
| POST | `/api/bids` | bidder | [8](#post-apibids) |
| GET | `/api/wallet` | bidder | [9](#get-apiwallet) |
| GET | `/api/wallet/transactions` | bidder | [9](#get-apiwallettransactions) |
| POST | `/api/wallet/topup` | bidder | [9](#post-apiwallettopup) |
| GET | `/api/orders/mine` | bidder | [10](#get-apiordersmine) |
| GET | `/api/orders/:id` | bidder | [10](#get-apiordersid) |
| POST | `/api/orders/:id/pay` | bidder | [10](#post-apiordersidpay) |
| POST | `/api/orders/:id/shipping-address` | bidder | [10](#post-apiordersidshipping-address) |
| GET | `/api/orders/selling` | seller | [10](#get-apiordersselling) |
| POST | `/api/orders/:id/ship-to-warehouse` | seller | [10](#post-apiordersidship-to-warehouse) |
| GET | `/api/orders/:id/tracking` | bidder, seller | [10](#get-apiordersidtracking) |
| GET | `/api/warehouse/orders` | warehouse | [11](#get-apiwarehouseorders) |
| POST | `/api/warehouse/orders/:id/receive` | warehouse | [11](#post-apiwarehouseordersidreceive) |
| POST | `/api/warehouse/orders/:id/inspect` | warehouse | [11](#post-apiwarehouseordersidinspect) |
| POST | `/api/warehouse/orders/:id/pack` | warehouse | [11](#post-apiwarehouseordersidpack) |
| POST | `/api/warehouse/orders/:id/ship` | warehouse | [11](#post-apiwarehouseordersidship) |
| POST | `/api/warehouse/orders/:id/deliver` | warehouse | [11](#post-apiwarehouseordersiddeliver) |
| POST | `/api/orders/:id/confirm-delivery` | bidder | [12](#post-apiordersidconfirm-delivery) |
| POST | `/api/disputes` | bidder, seller | [13](#post-apidisputes) |
| GET | `/api/disputes/mine` | bidder, seller | [13](#get-apidisputesmine) |
| GET | `/api/admin/disputes` | admin | [13](#get-apiadmindisputes) |
| POST | `/api/admin/disputes/:id/resolve` | admin | [13](#post-apiadmindisputesidresolve) |
| GET | `/api/admin/dashboard` | admin | [14](#get-apiadmindashboard) |
| GET | `/api/admin/report/weekly` | admin | [14](#get-apiadminreportweekly) |
| GET | `/api/admin/flags` | admin | [14](#get-apiadminflags) |
| POST | `/api/admin/flags/:id/action` | admin | [14](#post-apiadminflagsidaction) |
| GET | `/api/admin/ops-accounts` | admin | [14](#get-apiadminops-accounts) |
| POST | `/api/admin/ops-accounts` | admin | [14](#post-apiadminops-accounts) |
| PATCH | `/api/admin/ops-accounts/:id` | admin | [14](#patch-apiadminops-accountsid) |
| GET | `/api/admin/accounts` | admin | [14](#get-apiadminaccounts) |
| PATCH | `/api/admin/accounts/:id` | admin | [14](#patch-apiadminaccountsid) |
| GET | `/api/notifications` | bidder, seller | [15](#get-apinotifications) |
| POST | `/api/notifications/:id/read` | bidder, seller | [15](#post-apinotificationsidread) |
| POST | `/api/chat/messages` | bidder, seller | [16](#post-apichatmessages) |
| GET | `/api/chat/sessions/:id/messages` | bidder, seller | [16](#get-apichatsessionsidmessages) |
| POST | `/api/ai/suggest-price` | seller, appraiser | [16](#post-apiaisuggest-price) |
