# API — Marketplace Operations (BE2)

API phần đấu giá, ví, đặt giá, thanh toán (BE1) xem [`api_be1.md`](api_be1.md). Luồng nghiệp vụ tổng thể xem [`mainflow.md`](mainflow.md).

## Quy ước chung

- Base URL: `http://localhost:5000` (emulator Android: `http://10.0.2.2:5000`).
- Mọi route trừ `/api/health` và `/api/auth/*` cần header `Authorization: Bearer <token>`.
- Phản hồi luôn có dạng:

```json
{ "success": true,  "data": { ... }, "error": null }
{ "success": false, "data": null,    "error": { "code": "VALIDATION_ERROR", "message": "Email không đúng định dạng" } }
```

- Tiền là VND, số nguyên. Thời gian là chuỗi ISO 8601. `id` là chuỗi số.
- Danh sách nhận `?limit=` (mặc định 50, tối đa 100) và `?offset=`.

### Mã lỗi dùng chung

| HTTP | `code` | Khi nào |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Thiếu trường, sai kiểu, sai định dạng, ngoài khoảng cho phép |
| 400 | `INVALID_JSON` | Body không phải JSON hợp lệ |
| 401 | `UNAUTHORIZED` | Thiếu token, token sai / hết hạn, tài khoản không còn tồn tại |
| 403 | `FORBIDDEN` | Sai vai trò cho route này |
| 403 | `ACCOUNT_SUSPENDED` | Tài khoản bị khoá (kể cả khi token còn hạn) |
| 404 | `NOT_FOUND` | Không tồn tại **hoặc không thuộc về bạn** (không phân biệt để không lộ dữ liệu người khác) |
| 409 | `INVALID_STATE` | Thao tác sai thứ tự trạng thái (ví dụ duyệt tin đang `needs_info`) |
| 500 | `INTERNAL_ERROR` | Lỗi hệ thống (production chỉ trả "Lỗi hệ thống") |

Vai trò trong token: `bidder`, `seller` (bảng `accounts`, `kind: 'account'`) và `appraiser`, `warehouse`, `admin` (bảng `ops_accounts`, `kind: 'ops'`).

---

## 1. Xác thực

| Method | Đường dẫn | Vai trò | Body |
|---|---|---|---|
| POST | `/api/auth/register` | công khai | `{ fullName, email, password, role: 'bidder' \| 'seller', phone?, shopName? }` |
| POST | `/api/auth/login` | công khai | `{ email, password }` (Bidder / Seller) |
| POST | `/api/auth/ops/login` | công khai | `{ email, password }` (Thẩm định / Kho / Admin) |
| GET | `/api/me` | mọi vai trò | — |

Quy tắc đăng ký: email đúng định dạng, mật khẩu 6–72 ký tự, họ tên không rỗng, vai trò chỉ `bidder` hoặc `seller`.

```json
// POST /api/auth/register -> 201
{ "success": true, "error": null, "data": {
  "account": { "id": "31", "fullName": "Người mua Một", "email": "a@example.com", "phone": null, "avatarUrl": null, "status": "active" },
  "role": "bidder",
  "token": "eyJhbGciOi..."
} }
```

Lỗi: `400 VALIDATION_ERROR`, `409 EMAIL_TAKEN`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_SUSPENDED`.

## 2. Thông báo

| Method | Đường dẫn | Vai trò | Ghi chú |
|---|---|---|---|
| GET | `/api/notifications` | bidder, seller | `{ notifications: [{ id, type, title, isRead, createdAt }], unreadCount }` |
| POST | `/api/notifications/:id/read` | bidder, seller | Đánh dấu đã đọc |

`type` đang dùng: `outbid`, `win`, `refund`, `sold`, `warn`, `info`, `order`, `payout`, `dispute`, `listing_approved`, `listing_rejected`, `listing_needs_info`. Real-time: Socket.io `notification:new` vào phòng `user:<accountId>`. Tài khoản ops gọi trả `403 FORBIDDEN`.

## 3. Danh mục và tin đăng (Seller)

| Method | Đường dẫn | Vai trò | Body / Query |
|---|---|---|---|
| GET | `/api/categories` | mọi vai trò | → `{ categories: [{ code, name }] }` |
| POST | `/api/listings` | seller | `{ title, categoryCode, startingPrice, durationHours, description?, condition?, aiSuggestedPrice? }` → tin `draft` |
| GET | `/api/listings/mine` | seller | `?status=draft\|pending_appraisal\|needs_info\|approved\|rejected\|live\|ended\|cancelled` |
| PATCH | `/api/listings/:id` | seller | Các trường như khi tạo (gửi trường nào sửa trường đó). Chỉ khi `draft` hoặc `needs_info` |
| POST | `/api/listings/:id/photos` | seller | `{ url }` hoặc `{ urls: [...] }`, `http(s)`, tối đa 10 ảnh/tin. Chỉ khi `draft` / `needs_info` |
| POST | `/api/listings/:id/submit` | seller | `draft` → `pending_appraisal`. Cần ít nhất 1 ảnh |
| POST | `/api/listings/:id/resubmit` | seller | `needs_info` → `pending_appraisal` |

Ràng buộc: `startingPrice` 1.000 – 10.000.000.000, `durationHours` 1 – 336.

```json
// POST /api/listings -> 201
{ "success": true, "error": null, "data": {
  "id": "41", "title": "Máy nghe nhạc", "category": "elec", "description": null, "condition": "Như mới",
  "startingPrice": 1000000, "aiSuggestedPrice": 2420000, "durationHours": 24, "status": "draft",
  "createdAt": "2026-10-09T15:30:00.000Z", "photos": [], "lastAppraisal": null, "auction": null
} }
```

`lastAppraisal` = `{ decision, reason, decidedAt }` của lần thẩm định gần nhất (để Seller biết vì sao bị từ chối / cần bổ sung). `auction` = `{ id, status, currentPrice, endsAt }` khi đã có phiên.

Lỗi: `404 NOT_FOUND` (không phải tin của bạn), `409 INVALID_STATE`, `400 PHOTOS_REQUIRED`.

## 4. Thẩm định (Appraiser)

| Method | Đường dẫn | Vai trò | Body / Query |
|---|---|---|---|
| GET | `/api/appraisals/queue` | appraiser | `?status=pending_appraisal` (mặc định) `\| needs_info` |
| GET | `/api/appraisals/:listingId` | appraiser | Chi tiết tin, ảnh, người bán, `history` mọi lần quyết định |
| POST | `/api/appraisals/:listingId/decision` | appraiser | `{ decision: 'approve' \| 'reject' \| 'more_info', reason }` (`reason` bắt buộc khi `reject` / `more_info`) |

Mỗi quyết định thêm **một dòng mới** vào `appraisals`. Chỉ quyết định được khi tin đang `pending_appraisal` (khác → `409 INVALID_STATE`).

- `approve`: tin → `approved`, gọi `createAuctionForListing` (BE1) trong cùng giao dịch, phiên mở ngay và tin → `live`.
- `reject`: tin → `rejected`. `more_info`: tin → `needs_info`. Cả ba đều thông báo cho Seller.

```json
// POST /api/appraisals/41/decision { "decision": "approve" } -> 201
{ "success": true, "error": null, "data": {
  "appraisalId": "15", "decidedAt": "2026-10-09T15:31:00.000Z", "listingId": "41",
  "decision": "approve", "listingStatus": "live", "auctionId": "34"
} }
```

## 5. Gợi ý giá

| Method | Đường dẫn | Vai trò | Body |
|---|---|---|---|
| POST | `/api/ai/suggest-price` | seller, appraiser | `{ categoryCode, condition? }` |

Chưa gọi mô hình AI. Từ 3 phiên cùng danh mục đã kết thúc trở lên thì gợi ý theo lịch sử (`basis: 'history'`), ít hơn thì dùng khung giá soạn sẵn (`basis: 'default'`).

```json
{ "success": true, "error": null, "data": {
  "suggestedStartingPrice": 2420000, "expectedFinalRange": [2600000, 4150000],
  "basis": "history", "sampleSize": 9, "explanation": "Dựa trên 9 phiên cùng danh mục đã kết thúc: ..."
} }
```

## 6. Đơn hàng sau bán (Seller, Bidder)

| Method | Đường dẫn | Vai trò | Ghi chú |
|---|---|---|---|
| GET | `/api/orders/selling` | seller | Đơn đã bán của tôi, `?stage=` (xem bảng giai đoạn) |
| POST | `/api/orders/:id/ship-to-warehouse` | seller | Báo đã gửi hàng về kho. Đơn phải `paid`, chưa gửi, không có tranh chấp |
| POST | `/api/orders/:id/shipping-address` | bidder | `{ addressId }` — chọn / đổi địa chỉ giao hàng cho đơn của mình, được đổi tới trước khi kho gửi đi (xem mục 6a) |
| POST | `/api/orders/:id/confirm-delivery` | bidder | Xác nhận đã nhận hàng → giải ngân cho Seller |
| GET | `/api/orders/:id/tracking` | bidder, seller | Tiến trình kho / vận chuyển / giải ngân của đơn của mình. Chỉ người mua thấy `shippingAddress` |

Đơn hàng do BE1 tạo khi phiên kết thúc; xem và thanh toán qua `GET /api/orders/mine`, `GET /api/orders/:id`, `POST /api/orders/:id/pay` (BE1).

Giai đoạn (`stage`) suy ra từ dữ liệu:

| `stage` | Nghĩa |
|---|---|
| `awaiting_payment` / `payment_expired` | Chờ thanh toán / quá hạn 24 giờ |
| `awaiting_seller_shipment` | Đã thanh toán, chờ Seller gửi kho |
| `in_transit_to_warehouse` | Seller đã gửi, kho chưa nhận (`warehouse_receipts.received_at` rỗng) |
| `inspecting` | Kho đã nhận, chưa kiểm |
| `inspection_failed` | Kiểm không khớp (tranh chấp nguồn kho) |
| `inspected` | Kiểm đạt, chưa đóng gói |
| `packed` / `shipped` / `delivered` | Theo `shipments.status` |
| `completed` | Đã giải ngân (`payout_status = 'released'`) |

```json
// POST /api/orders/18/confirm-delivery -> 200 (rút gọn)
{ "success": true, "error": null, "data": {
  "id": "18", "title": "Máy nghe nhạc", "finalPrice": 1150000, "paymentStatus": "paid",
  "payoutStatus": "released", "payoutDeadline": "2026-10-12T15:35:00.000Z",
  "deliveredConfirmedAt": "2026-10-09T15:36:00.000Z", "stage": "completed",
  "warehouse": { "orderCode": "BV-091026-0018", "receivedAt": "...", "inspectionResult": "match", "inspectionNotes": "...", "inspectedBy": "Kho test" },
  "shipment": { "status": "delivered", "trackingCode": "GHNTEST0001", "updatedAt": "..." },
  "shippingAddress": { "id": "1", "recipientName": "Người mua Một", "phone": "0903 112 233",
    "addressLine": "45A Võ Văn Tần", "ward": "Phường 6", "district": "Quận 3", "city": "TP.HCM" },
  "events": [ { "step": "packing", "note": "...", "at": "..." }, { "step": "shipped", ... }, { "step": "delivered", ... } ]
} }
```

Lỗi `409`: `INVALID_STATE`, `ALREADY_SHIPPED`, `DISPUTE_OPEN`, `NOT_DELIVERED`, `ALREADY_CONFIRMED`, `ALREADY_RELEASED`.

## 6a. Địa chỉ giao hàng (Bidder)

| Method | Đường dẫn | Vai trò | Body |
|---|---|---|---|
| GET | `/api/addresses` | bidder | → `{ addresses: [...] }`, địa chỉ mặc định đứng đầu |
| POST | `/api/addresses` | bidder | `{ recipientName, phone, addressLine, city, ward?, district?, isDefault? }` |
| PATCH | `/api/addresses/:id` | bidder | Các trường như khi thêm (gửi trường nào sửa trường đó) |
| POST | `/api/addresses/:id/default` | bidder | Đặt làm địa chỉ mặc định |
| DELETE | `/api/addresses/:id` | bidder | Xoá |
| POST | `/api/orders/:id/shipping-address` | bidder | `{ addressId }` — gắn địa chỉ vào đơn của mình |

Quy tắc:
- Bắt buộc `recipientName`, `phone` (9–15 chữ số, cho phép khoảng trắng, `+`, `-`, `.`, ngoặc), `addressLine`, `city`. Tối đa 10 địa chỉ mỗi tài khoản.
- Địa chỉ đầu tiên tự thành mặc định; mỗi tài khoản chỉ có một địa chỉ mặc định. Xoá địa chỉ mặc định thì địa chỉ mới nhất còn lại thành mặc định.
- Địa chỉ của người khác (hoặc đã xoá) trả `404 NOT_FOUND` ở mọi thao tác.
- **Giữ đúng lịch sử giao hàng:** xoá là xoá mềm, đơn đã gửi vẫn đọc được địa chỉ cũ. Sửa một địa chỉ mà đơn đã gửi đi đang dùng thì backend tạo **địa chỉ mới với `id` mới** (phản hồi trả `id` mới), đơn đã gửi giữ bản cũ, đơn chưa gửi chuyển sang bản mới. Xoá địa chỉ thì đơn chưa gửi đang dùng nó bị bỏ gắn, người mua phải chọn lại.
- Gắn vào đơn: đơn của mình, chưa quá hạn thanh toán, kho chưa gửi đi (sau bước `/ship` trả `409 ALREADY_SHIPPED`). Có thể gắn ngay từ lúc đơn còn chờ thanh toán.

```json
// POST /api/addresses -> 201
{ "success": true, "error": null, "data": {
  "id": "1", "recipientName": "Người mua Một", "phone": "0903 112 233", "addressLine": "45 Võ Văn Tần",
  "ward": "Phường 6", "district": "Quận 3", "city": "TP.HCM", "isDefault": true, "createdAt": "..."
} }
```

## 7. Kho vận (Warehouse)

| Method | Đường dẫn | Body | Điều kiện → kết quả |
|---|---|---|---|
| GET | `/api/warehouse/orders` | `?stage=` | Đơn Seller đã báo gửi; có tên, số điện thoại người mua và `shippingAddress` (null nếu người mua chưa chọn) |
| POST | `/api/warehouse/orders/:id/receive` | — | Seller đã báo gửi, chưa nhận → ghi `received_at` |
| POST | `/api/warehouse/orders/:id/inspect` | `{ result: 'match' \| 'mismatch', notes }` | Đã nhận, chưa kiểm. `mismatch` bắt buộc `notes`, tự mở tranh chấp nguồn `warehouse` (`reporter_id` NULL), `payout_status` → `disputed` |
| POST | `/api/warehouse/orders/:id/pack` | `{ notes? }` | Kiểm đạt, chưa có tranh chấp → `shipments.status = 'packing'` |
| POST | `/api/warehouse/orders/:id/ship` | `{ carrier, trackingCode }` | `packing` → `shipped`. Đơn chưa có địa chỉ giao hàng → `409 ORDER_NO_ADDRESS` |
| POST | `/api/warehouse/orders/:id/deliver` | — | `shipped` → `delivered`, đặt `payout_deadline` = bây giờ + 72 giờ |

Mỗi bước ghi một dòng `shipment_events`; sai thứ tự trả `409 INVALID_STATE`. Bước nhận / gửi / giao thông báo cho người mua.

## 8. Tranh chấp

| Method | Đường dẫn | Vai trò | Body |
|---|---|---|---|
| POST | `/api/disputes` | bidder, seller | `{ orderId, title, reason }` — chỉ trên đơn của mình, đã `paid`, chưa giải ngân, chưa có tranh chấp |
| GET | `/api/disputes/mine` | bidder, seller | Tranh chấp trên các đơn của tôi |
| GET | `/api/admin/disputes` | admin | `?status=open\|resolved` |
| POST | `/api/admin/disputes/:id/resolve` | admin | `{ resolution: 'refund' \| 'keep', note? }` |

- Mở: ghi `disputes` (`escrow_amount` = số người mua đã trả), 2 dòng `dispute_timeline`, `payout_status` → `disputed`, thông báo bên kia.
- `refund`: `wallet_service.refund` (BE1) cộng tiền về ví người mua (một dòng `wallet_transactions` loại `refund`), tin đăng → `cancelled`, `payout_status` giữ `disputed`.
- `keep`: `payout_status` → `released` (trừ khi đơn còn tranh chấp khác đang mở).

```json
// GET /api/admin/disputes?status=open -> 200 (một phần tử)
{ "id": "5", "orderId": "19", "itemTitle": "Bình gốm", "source": "warehouse", "reporterId": null,
  "title": "Bình gốm — hàng không khớp mô tả khi kiểm", "status": "open", "escrowAmount": 1143000,
  "resolution": "none", "resolvedBy": null, "payoutStatus": "disputed",
  "buyer": { "id": "33", "name": "Người mua Hai" }, "seller": { "id": "31", "storeName": "Shop test" },
  "timeline": [ { "note": "Kho phát hiện sai lệch khi kiểm hàng: ...", "at": "..." }, { "note": "...", "at": "..." } ] }
```

Lỗi `409`: `DISPUTE_OPEN`, `ALREADY_RELEASED`, `ALREADY_RESOLVED`, `INVALID_STATE`.

## 9. Admin

Tất cả cần vai trò `admin`.

| Method | Đường dẫn | Body / Query | Ghi chú |
|---|---|---|---|
| GET | `/api/admin/dashboard` | — | Số phiên live / sắp kết thúc, hàng chờ thẩm định, đơn theo giai đoạn kho, cờ, tranh chấp, người dùng, `escrowHeld` |
| GET | `/api/admin/report/weekly` | — | 7 ngày gần nhất: phiên kết thúc, đơn, GMV, phí ước tính, thanh toán / quá hạn, tài khoản mới, quyết định thẩm định, tranh chấp, nạp ví, top danh mục |
| GET | `/api/admin/flags` | `?status=pending\|paused\|terminated\|verify\|safe` | Kèm `evidence`, thông tin phiên |
| POST | `/api/admin/flags/:id/action` | `{ action: 'pause' \| 'terminate' \| 'verify' \| 'safe', reason }` | `terminate` bắt buộc `reason` |
| GET | `/api/admin/ops-accounts` | `?role=&status=` | |
| POST | `/api/admin/ops-accounts` | `{ name, email, role: 'appraiser' \| 'warehouse' \| 'admin', password }` | Mật khẩu băm bcrypt. Trùng email → `409 EMAIL_TAKEN` |
| PATCH | `/api/admin/ops-accounts/:id` | `{ name?, role?, status?, password? }` | Không tự khoá / tự bỏ quyền Admin (`409 SELF_LOCKOUT`). Khoá thì ngắt ngay socket đang mở (xem dưới) |
| GET | `/api/admin/accounts` | `?role=bidder\|seller&status=&q=` | Tìm theo tên / email |
| PATCH | `/api/admin/accounts/:id` | `{ status: 'active' \| 'suspended' }` | Khoá có hiệu lực ngay: REST trả `403 ACCOUNT_SUSPENDED` kể cả với token đang dùng, và socket đang mở bị ngắt (xem dưới) |

**Khoá tài khoản và Socket.io.** Sau khi việc khoá đã lưu xuống DB, backend gọi `disconnectAccount` của BE1 (xem [`socket.md`](socket.md)). Mọi kết nối đang mở của tài khoản đó nhận sự kiện `account:disconnected` `{ code: 'ACCOUNT_SUSPENDED', message: 'Tài khoản đã bị khoá' }` rồi bị ngắt. Kết nối lại bị từ chối với `connect_error` `ACCOUNT_SUSPENDED` cho tới khi được mở khoá. Áp dụng cho cả Bidder / Seller và tài khoản nội bộ. Nếu việc ngắt socket bị lỗi thì backend chỉ ghi log, API khoá vẫn trả `200` vì tài khoản đã bị khoá. Mở khoá không cần làm gì thêm, app kết nối lại bình thường.

Hành động với cờ (`flagged_auctions.status`):

| `action` | Trạng thái cờ | Tác dụng |
|---|---|---|
| `pause` | `paused` | Phiên không nhận cọc / lượt giá mới và không bị đóng tự động (cơ chế có sẵn của BE1). Không sửa `ends_at` |
| `verify` | `verify` | Đang xác minh; nếu đang `paused` thì phiên chạy lại |
| `safe` | `safe` | Đóng cờ, phiên chạy bình thường |
| `terminate` | `terminated` | Gọi `cancelAuction` (BE1): huỷ phiên, hoàn cọc mọi người, thông báo. Phiên không còn `active` → `409 AUCTION_ENDED` |

Cờ đã `terminated` hoặc `safe` không đổi được nữa (`409 INVALID_STATE`).

## 10. Chatbot

| Method | Đường dẫn | Vai trò | Body |
|---|---|---|---|
| POST | `/api/chat/messages` | bidder, seller | `{ content, sessionId? }` — không có `sessionId` thì mở phiên mới |
| GET | `/api/chat/sessions/:id/messages` | bidder, seller | Lịch sử của phiên của mình |

Trả lời soạn sẵn theo từ khoá (cọc, đặt giá, thanh toán, giao hàng, giải ngân, tranh chấp, ví, đăng tin), chưa gọi mô hình AI.

```json
// POST /api/chat/messages { "content": "Đặt cọc như thế nào?" } -> 201
{ "success": true, "error": null, "data": { "sessionId": "1", "messages": [
  { "id": "1", "sender": "user", "content": "Đặt cọc như thế nào?", "createdAt": "..." },
  { "id": "2", "sender": "bot", "content": "Để tham gia một phiên, bạn đặt cọc 10% giá khởi điểm ...", "createdAt": "..." }
] } }
```
