# BidVibe Backend

Backend cho BidVibe - nền tảng đấu giá trực tuyến thời gian thực cho đồ cũ/vật phẩm sưu tầm.

## Cài đặt

```bash
npm install
cp .env.example .env   # rồi điền giá trị thật vào .env
npm run dev
```

## Cấu trúc thư mục

```
src/
├── config/       # kết nối DB, cấu hình dùng chung
├── middleware/    # auth, error handler
├── models/        # định nghĩa dữ liệu Firestore
├── routes/        # định tuyến API
├── services/       # logic nghiệp vụ chính
├── sockets/        # xử lý real-time (Socket.io)
└── app.js          # entry point
```

## Phân chia công việc

| Domain | Phụ trách | Phạm vi |
|---|---|---|
| Auction Core | BE1 | `auction.*`, `bid.*`, `wallet.*`, `fraud_detection.js`, `sockets/` |
| Marketplace Operations | BE2 | `auth.*`, `product.*`, `appraisal.*`, `warehouse.*`, `admin.*`, `ai_price_suggestion.js`, `ai_report_service.js` |

Chi tiết quy ước API và kiến trúc: xem [`docs/architecture.md`](docs/architecture.md).

## Quy ước Git

- Nhánh chính: `main` (ổn định), `develop` (tích hợp)
- Nhánh tính năng: `feature/be1-...` hoặc `feature/be2-...`
- Merge vào `develop` qua Pull Request, cần review trước khi merge
