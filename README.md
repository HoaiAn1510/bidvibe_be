# BidVibe Backend

Backend cho BidVibe - nền tảng đấu giá trực tuyến thời gian thực cho đồ cũ/vật phẩm sưu tầm.

Công nghệ: Node.js + Express 5 + Socket.io, dữ liệu lưu trong PostgreSQL (host trên Supabase), kết nối bằng thư viện `pg`.

## Cài đặt

```bash
npm install
cp .env.example .env   # rồi điền giá trị thật vào .env
npm run db:migrate     # tạo/cập nhật bảng trong database
npm run dev
```

### Biến môi trường

Xem đầy đủ trong `.env.example`. Các biến quan trọng:

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | Chuỗi kết nối Postgres. Với Supabase dùng chuỗi **Session pooler** (host `*.pooler.supabase.com`, cổng 5432, username dạng `postgres.<mã project>`). **Không** dùng Direct connection: nó chỉ có IPv6 nên nhiều mạng không kết nối được. |
| `DB_SSL` | `true` khi dùng Supabase. |
| `JWT_SECRET` | Khoá ký token đăng nhập. Bắt buộc, không có giá trị mặc định. |
| `AUTO_PAYOUT_ENABLED` | `false` để tắt job tự giải ngân sau 72 giờ (mặc định bật). |

File `.env` chứa mật khẩu nên **không được đưa lên git** (đã có trong `.gitignore`). Mỗi người tự tạo `.env` của mình.

### Các lệnh npm

| Lệnh | Việc |
|---|---|
| `npm run dev` | Chạy server, tự khởi động lại khi sửa code |
| `npm start` | Chạy server (không tự khởi động lại) |
| `npm run db:migrate` | Chạy các file trong `migrations/` chưa được áp dụng |
| `npm run db:seed` | Thêm dữ liệu demo (BE1 + BE2), chạy lại nhiều lần không bị trùng. Mật khẩu demo `123456` |
| `npm run test:be1` | Kiểm thử end-to-end phần đấu giá/ví/tạm dừng/gian lận trên DB dùng chung (tài khoản `test_be1_*`, tự dọn) |
| `npm run test:be2` | Kiểm thử end-to-end phần BE2 qua HTTP thật (tài khoản `test_be2_*`, tự dọn) |
| `npm test` | Chạy cả `test:be1` và `test:be2` |

#### Chạy kiểm thử trên database dùng chung

Cả hai bộ test chạy trên Supabase dùng chung nên được viết để **không đụng dữ liệu thật**:

- Mọi dữ liệu test có tiền tố riêng: `test_be1_*` (BE1: email `test_be1_<tên>_<số>@be1test.local`, tin đăng `test_be1_item`) và `test_be2_*` (BE2).
- Test chỉ ghi/xoá các dòng đi ra từ những tài khoản có tiền tố đó. Cuối mỗi lần chạy (kể cả khi test lỗi) và đầu lần chạy kế tiếp, các dòng này được xoá sạch; dữ liệu seed và dữ liệu của đồng đội không bị sửa hay xoá.
- Chạy được lúc đồng đội đang chạy server: scheduler của họ có thể đóng phiên test của bạn, test BE1 đã chờ DB về đúng trạng thái. Nếu vẫn lỗi lặt vặt thì chạy lại.
- Nếu test bị ngắt giữa chừng (Ctrl+C), cứ chạy lại là dọn được phần dở. Kiểm tra còn sót không: `SELECT count(*) FROM accounts WHERE email LIKE 'test\_be1\_%'`.
- Cần database đã chạy `npm run db:migrate` (test BE1 cần migration `006`).

## Cấu trúc thư mục

```
migrations/        # file SQL tạo/đổi cấu trúc database (001, 002, ...)
scripts/           # script chạy tay (migrate.js, ...)
docs/              # tài liệu kiến trúc và API
src/
├── config/        # kết nối DB (db.js), biến môi trường (env.js)
├── middleware/    # auth, error handler
├── models/        # truy vấn/ánh xạ dữ liệu theo từng bảng
├── routes/        # định tuyến API
├── services/      # logic nghiệp vụ chính
├── sockets/       # xử lý real-time (Socket.io)
└── app.js         # entry point
```

## Cơ sở dữ liệu

Schema gốc nằm trong `migrations/001_init_schema.sql` (23 bảng nghiệp vụ), các migration sau chỉ thêm: `003` mật khẩu tài khoản nội bộ, `004` loại giao dịch ví mất cọc, `005` bảng `addresses` và `orders.shipping_address_id`, `006` (BE1) `auctions.paused_at` + trigger đóng băng đồng hồ khi tạm dừng, unique index chặn cờ gian lận `pending` trùng. Thư mục `migrations/` là nguồn sự thật cho cấu trúc dữ liệu. Sơ đồ quan hệ xem trong Supabase: **Database → Schema Visualizer**.

| Nhóm | Bảng |
|---|---|
| Tài khoản | `accounts`, `bidders`, `sellers`, `ops_accounts` |
| Tin đăng & thẩm định | `categories`, `listings`, `listing_photos`, `appraisals` |
| Đấu giá | `auctions`, `auction_deposits`, `bids` |
| Đơn hàng, kho, vận chuyển | `orders`, `addresses` (địa chỉ giao hàng, migration 005), `warehouse_receipts`, `shipments`, `shipment_events` |
| Ví | `wallet_transactions` |
| Thông báo & chatbot | `notifications`, `chat_sessions`, `chat_messages` |
| Gắn cờ & tranh chấp | `flagged_auctions`, `flag_evidence`, `disputes`, `dispute_timeline` |

Quyết định thiết kế cần nhớ:

- Bidder và Seller là hai role tách biệt: `accounts` giữ phần đăng nhập chung, `bidders` / `sellers` là bảng con 1-1, một account chỉ thuộc một trong hai. Ví (`wallet_balance`, `wallet_held`) chỉ Bidder có.
- Tài khoản Thẩm định / Kho vận / Admin nằm riêng ở `ops_accounts`.
- Cọc tham gia phiên (`auction_deposits`, 10% giá khởi điểm) tách khỏi lượt đặt giá (`bids`).
- Tiền là VND, kiểu `BIGINT`, không có phần thập phân.
- Hai mốc hạn trên `orders`: `payment_deadline` (+24 giờ kể từ lúc thắng, quá hạn thì mất cọc) và `payout_deadline` (+72 giờ sau khi giao, quá hạn thì tự giải ngân cho người bán).

### Quy tắc làm việc với database

- **Không sửa file migration đã chạy.** Muốn đổi cấu trúc thì thêm file mới (`003_...sql`). Chỉ một người chạy `npm run db:migrate` mỗi lần có file mới, rồi báo người còn lại.
- **RLS đã bật cho mọi bảng và không có policy nào** (`002_enable_rls.sql`), để chặn truy cập qua API công khai của Supabase. Backend kết nối bằng tài khoản `postgres` nên bỏ qua RLS và vẫn đọc ghi bình thường. Bảng mới thêm sau này cũng phải bật RLS trong chính file migration của nó.
- **Thao tác đụng tiền hoặc đổi trạng thái nhiều bảng phải nằm trong một giao dịch** (`BEGIN ... COMMIT`) dùng chung một kết nối lấy từ pool. Đặt giá phải khoá dòng phiên bằng `SELECT ... FOR UPDATE` để hai người không đặt trùng.
- Không tự cộng/trừ số dư. Mọi thay đổi ví đi qua service ví (xem bên dưới) để luôn có dòng trong `wallet_transactions`.

## Phân chia công việc

| Domain | Phụ trách | Phạm vi |
|---|---|---|
| Auction Core | BE1 | `auction.*`, `bid.*`, `wallet.*`, `fraud_detection.js`, `sockets/` |
| Marketplace Operations | BE2 | `auth.*`, `product.*`, `appraisal.*`, `warehouse.*`, `admin.*`, `ai_price_suggestion.js`, `ai_report_service.js` |

Hai domain nối nhau qua các điểm sau, cần tôn trọng:

- **Ví chỉ BE1 viết** (`wallet.*`), gồm các hàm giữ cọc, hoàn cọc, thanh toán, hoàn tiền; mỗi hàm nhận `client` để nằm chung giao dịch của nơi gọi. BE2 muốn hoàn tiền (ví dụ Admin xử lý tranh chấp) thì gọi hàm ví của BE1, không tự sửa số dư.
- **Thông báo do BE2 viết** (hàm tạo thông báo, ghi bảng `notifications` và đẩy qua Socket.io nếu người nhận đang online). BE1 gọi hàm này khi có người bị vượt giá hoặc thắng phiên.
- **Tạo phiên đấu giá:** khi Thẩm định duyệt một tin đăng, BE2 gọi một hàm do BE1 cung cấp để sinh `auctions`; BE2 không tự ghi vào bảng `auctions`.
- **Đơn hàng (`orders`):** BE1 tạo khi phiên kết thúc; BE2 đọc và cập nhật phần kho, giao hàng, giải ngân. Địa chỉ giao hàng (`orders.shipping_address_id`) do người mua chọn qua API của BE2 (`POST /api/orders/:id/shipping-address`), luồng thanh toán của BE1 không đổi; kho không gửi được hàng khi đơn chưa có địa chỉ (`409 ORDER_NO_ADDRESS`).
- **Đăng nhập:** `auth.*` do BE2 phụ trách. Bidder / Seller đăng nhập qua `accounts.password_hash`, Thẩm định / Kho vận / Admin qua `ops_accounts.password_hash` (thêm ở migration `003`); tài khoản ops do Admin tạo qua `POST /api/admin/ops-accounts`.
- **Tự giải ngân:** job của BE2 (`payout_service.releaseOverduePayouts`) chạy chung vòng `scheduler.js` của BE1, tắt bằng `AUTO_PAYOUT_ENABLED=false`.

Chi tiết quy ước API và kiến trúc: xem [`docs/architecture.md`](docs/architecture.md).
API: phần BE1 ở [`docs/api_be1.md`](docs/api_be1.md), phần BE2 ở [`docs/api.md`](docs/api.md), sự kiện Socket.io ở [`docs/socket.md`](docs/socket.md). Kết quả kiểm thử BE2: [`docs/test-be2.md`](docs/test-be2.md).
Luồng nghiệp vụ từ đăng ký đến giải ngân (kèm trạng thái triển khai, sơ đồ, luồng tiền): xem [`docs/mainflow.md`](docs/mainflow.md).

## Quy ước Git

- Nhánh chính: `main` (ổn định), `develop` (tích hợp)
- Nhánh tính năng: `feature/be1-...` hoặc `feature/be2-...`
- Merge vào `develop` qua Pull Request, cần review trước khi merge
- Không commit `.env`, chuỗi kết nối hay mật khẩu