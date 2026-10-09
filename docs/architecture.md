# Kiến trúc & Quy ước — BidVibe Backend

## Quy ước response API

Mọi endpoint trả về theo format thống nhất (theo đúng `middleware/errorHandler.js`):

```json
// Thành công
{ "success": true, "data": { ... }, "error": null }

// Lỗi
{ "success": false, "data": null, "error": { "code": "NOT_FOUND", "message": "Mô tả lỗi" } }
```

`code` là mã lỗi dạng hằng (`NOT_FOUND`, `UNAUTHORIZED`, `INTERNAL_ERROR`...) để client switch theo, `message` là mô tả cho người dùng — khi `NODE_ENV=production` và lỗi 5xx thì `message` bị ẩn thành "Lỗi hệ thống" để không lộ chi tiết nội bộ.

## Phân chia domain

### BE1 — Auction Core
- `models/auction.model.js`, `models/bid.model.js`, `models/wallet.model.js`
- `routes/auction.routes.js`, `routes/bid.routes.js`, `routes/wallet.routes.js`
- `services/auction_engine.js`, `services/wallet_service.js`, `services/fraud_detection.js`
- `sockets/auction_socket.js`

### BE2 — Marketplace Operations
- `models/user.model.js`, `models/product.model.js`, `models/dispute.model.js`
- `routes/auth.routes.js`, `routes/product.routes.js`, `routes/appraisal.routes.js`, `routes/warehouse.routes.js`, `routes/admin.routes.js`
- `services/ai_price_suggestion.js`, `services/ai_report_service.js`, `services/appraisal_service.js`, `services/warehouse_service.js`

### Dùng chung (hạn chế sửa sau khi đã thống nhất)
- `config/env.js`, `config/db.js`
- `middleware/errorHandler.js`, `middleware/auth.js` (`requireAuth` xác thực JWT, `requireRole` kiểm tra role)
- `migrations/` (schema PostgreSQL, chạy bằng `npm run db:migrate`)

## Quy tắc khi cần sửa file dùng chung

Báo trước trong nhóm chat, sửa nhanh gọn rồi push ngay để tránh xung đột với người còn lại.

## Luồng tích hợp giữa 2 domain

- `fraud_detection.js` (BE1) đọc dữ liệu từ `auction_engine.js` (cùng domain BE1) — không phụ thuộc BE2.
- `ai_price_suggestion.js` (BE2) cần đọc lịch sử phiên đấu giá đã kết thúc từ `auction.model.js` (BE1) — thống nhất trước cấu trúc field cần dùng.
- `ai_report_service.js` (BE2) tổng hợp dữ liệu từ cả `auction`/`bid` (BE1) và `product`/`dispute` (BE2).

Khi 1 domain cần đọc dữ liệu từ domain kia, chỉ đọc qua model đã thống nhất field, không tự ý sửa model của domain kia — nếu cần thêm field, trao đổi trước.

Hàm BE1 mà BE2 gọi (tên thật trong code, xem thêm `docs/api_be1.md`):

| Việc | Hàm |
|---|---|
| Thẩm định duyệt tin đăng → sinh phiên | `auction_engine.createAuctionForListing(client, listingId)` (handoff ghi là `createAuctionFromListing`, code dùng tên này) |
| Admin chấm dứt phiên | `auction_engine.cancelAuction(client, auctionId)` → sau COMMIT gọi `.emit()` |
| Admin xử lý tranh chấp = hoàn tiền | `wallet_service.refund(client, { bidderId, amount, auctionId })` |

## Thông báo

`services/notification_service.js` (BE2) là nơi duy nhất ghi bảng `notifications`:

- `notify(client, accountId, type, title)` — trong giao dịch thì chỉ ghi DB, nơi gọi phải `emitNotification(n)` **sau COMMIT**; gọi với `pool` (ngoài giao dịch) thì tự đẩy ngay.
- `createNotification(executor, { accountId, type, title })` / `emitNotification(n)` — giữ nguyên chữ ký vì BE1 đang dùng.
- Real-time: sự kiện `notification:new` gửi vào phòng `user:<accountId>` (socket tự vào phòng này khi kết nối bằng JWT tài khoản). `io` lấy qua `registerSockets.getIo()`, không cần truyền qua tham số.
- Chỉ tài khoản Bidder/Seller có thông báo; tài khoản nội bộ (ops) gọi API thông báo nhận `403 FORBIDDEN`.

## API BE2 hiện có

| Method | Đường dẫn | Ghi chú |
|---|---|---|
| POST | `/api/auth/register` | `{ fullName, email, phone?, password, role: 'bidder' \| 'seller', shopName? }`; email trùng → `409 EMAIL_TAKEN` |
| POST | `/api/auth/login` | Bidder/Seller → `{ account, role, token }` |
| POST | `/api/auth/ops/login` | Thẩm định / Kho vận / Admin |
| GET | `/api/me` | Hồ sơ của người đang đăng nhập (`kind: 'account' \| 'ops'`) |
| GET | `/api/notifications?limit=&offset=` | `{ notifications, unreadCount }` |
| POST | `/api/notifications/:id/read` | Đánh dấu đã đọc; thông báo của người khác → `404` |

## Quyết định mặc định cho các câu hỏi còn mở

Ghi lại để cả nhóm làm theo; đổi thì cập nhật mục này trước.

1. **Giải ngân cho Seller chỉ đổi `orders.payout_status`** (`pending` → `released`). Chưa có ví Seller, nên không cộng tiền vào đâu; tiền coi như nền tảng chuyển khoản cho người bán ngoài hệ thống.
2. **Ảnh tin đăng chỉ lưu URL** trong `listing_photos` (`url`, `order_index`). Backend không nhận file upload; app tự tải ảnh lên nơi khác rồi gửi URL. Seed dùng ảnh mẫu `picsum.photos`.
3. **AI gợi ý giá và chatbot dùng nội dung soạn sẵn**, chưa gọi mô hình thật (`ANTHROPIC_API_KEY` để trống). Giữ nguyên chữ ký hàm để sau này thay bằng lời gọi mô hình mà không đổi API.

## Dữ liệu demo

`npm run db:seed` chạy `scripts/seed_demo.js` (BE1: tài khoản cơ bản + 6 phiên đang diễn ra, gia hạn phiên khi chạy lại) rồi `scripts/seed.js` (BE2: đủ 3 tài khoản mỗi vai trò, tin đăng chờ thẩm định / bổ sung / từ chối / nháp, đơn hàng ở mọi trạng thái kho, cờ AI, tranh chấp). Cả hai idempotent vì database dùng chung: chỉ thêm phần còn thiếu, không xoá hay sửa dữ liệu có sẵn. Mật khẩu demo `123456`.
