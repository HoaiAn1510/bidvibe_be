# Kiến trúc & Quy ước — BidVibe Backend

> Cập nhật: 2026-10-10.

Tài liệu cho người viết backend. API cho app xem [`api.md`](api.md), Socket.io xem [`socket.md`](socket.md).

## Quy ước response API

Mọi endpoint trả về theo format thống nhất (theo đúng `middleware/errorHandler.js`):

```json
// Thành công
{ "success": true, "data": { ... }, "error": null }

// Lỗi
{ "success": false, "data": null, "error": { "code": "NOT_FOUND", "message": "Mô tả lỗi" } }
```

`code` là mã lỗi dạng hằng (`NOT_FOUND`, `UNAUTHORIZED`, `INTERNAL_ERROR`...) để client switch theo, `message` là mô tả cho người dùng — khi `NODE_ENV=production` và lỗi 5xx thì `message` bị ẩn thành "Lỗi hệ thống" để không lộ chi tiết nội bộ. Ném lỗi bằng `new AppError(message, statusCode, code)`; danh sách mã lỗi đang dùng ở [`api.md` mục 19](api.md#19-mã-lỗi-nghiệp-vụ).

## Phân chia domain (file thật trong `src/`)

### BE1 — Auction Core
- `models/auction.model.js`, `models/bid.model.js`, `models/wallet.model.js`
- `routes/auction.routes.js`, `routes/bid.routes.js`, `routes/wallet.routes.js`, `routes/order.routes.js`
- `services/auction_engine.js`, `services/wallet_service.js`, `services/fraud_detection.js`, `services/scheduler.js`
- `sockets/auction_socket.js`, `sockets/index.js`, `sockets/pause_listener.js`

### BE2 — Marketplace Operations
- `routes/auth.routes.js`, `routes/listing.routes.js`, `routes/appraisal.routes.js`, `routes/ai.routes.js`, `routes/address.routes.js`, `routes/fulfilment.routes.js`, `routes/warehouse.routes.js`, `routes/dispute.routes.js`, `routes/admin.routes.js`, `routes/notification.routes.js`, `routes/chat.routes.js`
- `services/auth_service.js`, `services/listing_service.js`, `services/appraisal_service.js`, `services/ai_price_suggestion.js`, `services/address_service.js`, `services/fulfilment_service.js`, `services/payout_service.js`, `services/dispute_service.js`, `services/admin_service.js`, `services/notification_service.js`, `services/chat_service.js`
- `utils/validate.js`

BE2 không có thư mục model riêng: truy vấn nằm trong service.

### Dùng chung (hạn chế sửa sau khi đã thống nhất)
- `app.js`, `routes/index.js`, `routes/_http.js`
- `config/env.js`, `config/db.js`
- `middleware/errorHandler.js`, `middleware/auth.js` (`requireAuth` xác thực JWT + kiểm tra trạng thái tài khoản, `requireRole` kiểm tra role)
- `migrations/` (schema PostgreSQL, chạy bằng `npm run db:migrate`)
- `scripts/` (`migrate.js`, `seed_demo.js` của BE1, `seed.js` của BE2, `test_be1.js`, `test_be2.js`, `docs_check.js`)

## Quy tắc khi cần sửa file dùng chung

Báo trước trong nhóm chat, sửa nhanh gọn rồi push ngay để tránh xung đột với người còn lại.

## Luồng tích hợp giữa 2 domain

- `fraud_detection.js` (BE1) đọc dữ liệu từ `auction_engine.js` / `bid.model.js` (cùng domain BE1) — không phụ thuộc BE2.
- `ai_price_suggestion.js` (BE2) đọc lịch sử phiên đã kết thúc qua `auction.model.listEndedHistory` (BE1).
- `admin_service.weeklyReport` (BE2) tổng hợp trực tiếp bằng SQL từ cả bảng của BE1 (`auctions`, `orders`, `wallet_transactions`) và BE2 (`appraisals`, `disputes`).

Khi 1 domain cần đọc dữ liệu từ domain kia, chỉ đọc qua model / hàm đã thống nhất, không tự ý sửa model của domain kia — nếu cần thêm field, trao đổi trước.

### Hàm BE1 mà BE2 gọi

Chữ ký đã chốt, không đổi. BE2 không tự ghi bảng `auctions` hay số dư ví.

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
// Dữ liệu cho gợi ý giá
await require('../models/auction.model').listEndedHistory({ categoryCode: 'shoes' });
// Khoá tài khoản: sau khi khoá đã lưu, ngắt socket đang mở (Promise<number> số kết nối đã ngắt)
await require('../sockets').disconnectAccount(id, { kind: 'account' | 'ops', reason });
```

Tạm dừng / tiếp tục phiên: BE2 chỉ cần đổi `flagged_auctions.status` sang / khỏi `'paused'`; trigger `flagged_auctions_sync_pause` (migration `006`) tự đóng băng và cộng bù đồng hồ (`auctions.paused_at`, `ends_at`), và (migration `007`) báo cho server phát `auction:update` (`reason: 'paused' | 'resumed'`) vào phòng phiên.

### Hàm BE2 mà BE1 gọi

- `notification_service.createNotification(executor, { accountId, type, title })` / `emitNotification(n)` — BE1 gọi cho `outbid`, `win`, `refund`, `sold`, `warn`.
- `payout_service.releaseOverduePayouts()` — gọi trong vòng 5 giây của `scheduler.js` (BE1), tắt bằng `AUTO_PAYOUT_ENABLED=false`.

## Thông báo

`services/notification_service.js` (BE2) là nơi duy nhất ghi bảng `notifications`:

- `notify(client, accountId, type, title)` — trong giao dịch thì chỉ ghi DB, nơi gọi phải `emitNotification(n)` **sau COMMIT**; gọi với `pool` (ngoài giao dịch) thì tự đẩy ngay.
- `createNotification(executor, { accountId, type, title })` / `emitNotification(n)` — giữ nguyên chữ ký vì BE1 đang dùng.
- Real-time: sự kiện `notification:new` gửi vào phòng `user:<accountId>` (socket tự vào phòng này khi kết nối bằng JWT tài khoản). `io` lấy qua `registerSockets.getIo()`, không cần truyền qua tham số.
- Chỉ tài khoản Bidder/Seller có thông báo; tài khoản nội bộ (ops) gọi API thông báo nhận `403 FORBIDDEN`.

## Quyết định mặc định cho các câu hỏi còn mở

Ghi lại để cả nhóm làm theo; đổi thì cập nhật mục này trước.

1. **Giải ngân cho Seller chỉ đổi `orders.payout_status`** (`pending` → `released`). Chưa có ví Seller, nên không cộng tiền vào đâu; tiền coi như nền tảng chuyển khoản cho người bán ngoài hệ thống.
2. **Ảnh tin đăng chỉ lưu URL** trong `listing_photos` (`url`, `order_index`). Backend không nhận file upload; app tự tải ảnh lên nơi khác rồi gửi URL. Seed dùng ảnh mẫu `picsum.photos`.
3. **AI gợi ý giá và chatbot dùng nội dung soạn sẵn**, chưa gọi mô hình thật (chưa có biến môi trường cho khoá AI). Giữ nguyên chữ ký hàm để sau này thay bằng lời gọi mô hình mà không đổi API.
4. **Chống chốt phút chót là 30 giây**, đúng như code BE1 (`SNIPE_WINDOW_MS`).
5. **Duyệt tin:** BE2 đặt `listings.status = 'approved'` rồi gọi `createAuctionForListing` (BE1) trong cùng giao dịch; hàm đó chuyển tin sang `live`. Vì vậy sau khi duyệt, tin luôn ở `live`, còn `approved` chỉ tồn tại bên trong giao dịch.
6. **"Seller đã gửi hàng về kho"** không có cột riêng trong schema: biểu diễn bằng một dòng `warehouse_receipts` có `received_at = NULL`; kho bấm nhận thì điền `received_at`. Không cần migration mới.
7. **Hoàn tiền tranh chấp:** schema không có `payout_status` kiểu "đã hoàn", nên sau khi hoàn đơn giữ `payout_status = 'disputed'` và tranh chấp ghi `resolution = 'refund'`; tin đăng chuyển `cancelled`.
8. **Địa chỉ giao hàng (migration 005):** đơn trỏ tới `addresses` qua `orders.shipping_address_id` (nullable cho đơn cũ). Để không làm sai lịch sử giao hàng: xoá là xoá mềm (`deleted_at`); sửa một địa chỉ mà đơn đã gửi đi đang dùng thì tạo dòng mới (id mới), đơn đã gửi giữ dòng cũ. Người mua chọn địa chỉ qua API riêng của BE2, không sửa luồng thanh toán của BE1.

## Dữ liệu demo

`npm run db:seed` chạy `scripts/seed_demo.js` (BE1: tài khoản cơ bản + 6 phiên đang diễn ra, gia hạn phiên khi chạy lại) rồi `scripts/seed.js` (BE2: đủ 3 tài khoản mỗi vai trò, tin đăng chờ thẩm định / bổ sung / từ chối / nháp, đơn hàng ở mọi trạng thái kho, địa chỉ giao hàng, cờ AI, tranh chấp). Cả hai idempotent vì database dùng chung: chỉ thêm phần còn thiếu, không xoá hay sửa dữ liệu có sẵn. Mật khẩu demo `123456`. Danh sách tài khoản: [`fe-quickstart.md`](fe-quickstart.md#2-tài-khoản-demo).
