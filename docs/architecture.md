# Kiến trúc & Quy ước — BidVibe Backend

## Quy ước response API

Mọi endpoint trả về theo format thống nhất:

```json
// Thành công
{ "success": true, "data": { ... } }

// Lỗi
{ "success": false, "error": "Mô tả lỗi ngắn gọn" }
```

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
- `config/env.js`, `config/firebase.js`
- `middleware/errorHandler.js`, `middleware/auth.js`

## Quy tắc khi cần sửa file dùng chung

Báo trước trong nhóm chat, sửa nhanh gọn rồi push ngay để tránh xung đột với người còn lại.

## Luồng tích hợp giữa 2 domain

- `fraud_detection.js` (BE1) đọc dữ liệu từ `auction_engine.js` (cùng domain BE1) — không phụ thuộc BE2.
- `ai_price_suggestion.js` (BE2) cần đọc lịch sử phiên đấu giá đã kết thúc từ `auction.model.js` (BE1) — thống nhất trước cấu trúc field cần dùng.
- `ai_report_service.js` (BE2) tổng hợp dữ liệu từ cả `auction`/`bid` (BE1) và `product`/`dispute` (BE2).

Khi 1 domain cần đọc dữ liệu từ domain kia, chỉ đọc qua model đã thống nhất field, không tự ý sửa model của domain kia — nếu cần thêm field, trao đổi trước.
