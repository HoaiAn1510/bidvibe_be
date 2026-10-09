# BidVibe — Bàn giao v2: backend đã nối Postgres thật

Thay cho `bidvibe_handoff.md` (bản v1) — v1 còn dặn "hỏi chọn backend trước khi code",
nhưng quyết định đó đã chốt: **giữ Node.js + Express 5 + Socket.io có sẵn trong
`bidvibe_be`, dùng PostgreSQL (host trên Supabase) làm nơi lưu dữ liệu chính.**
Dán file này cho Claude khi cần làm tiếp phần backend hoặc nối app Flutter.

## Bối cảnh

BidVibe là app đấu giá đồ cũ/đồ sưu tầm theo thời gian thực (đồ án FPT University).
App Flutter (`bidvibe_fe`) hiện chạy hoàn toàn bằng dữ liệu giả trong `lib/store.dart`
(`AppStore`), model ở `lib/models.dart`, **chưa nối vào backend thật**. 5 vai trò:
Người mua (Bidder), Người bán (Seller), Thẩm định (Appraiser), Kho vận (Warehouse),
Admin.

## Đã xong ở backend (`bidvibe_be`)

- Schema 23 bảng đã chạy lên Postgres (Supabase) qua `migrations/001_init_schema.sql`
  — là nguồn sự thật cho cấu trúc dữ liệu, không tự đổi tên bảng/cột nếu chưa hỏi.
- RLS (Row Level Security) đã bật cho cả 23 bảng, không tạo policy nào
  (`migrations/002_enable_rls.sql`) — chặn truy cập qua API công khai của Supabase;
  backend kết nối bằng role `postgres` nên bypass RLS, đọc/ghi bình thường.
- Gỡ bỏ Firebase (Firestore + Auth) khỏi backend — không còn dùng, dữ liệu và xác
  thực đều chuyển sang Postgres + JWT tự ký.
- `src/config/db.js`: connection pool dùng `pg`, dùng chung cho toàn app.
- `scripts/migrate.js`: chạy các file trong `migrations/` theo thứ tự, theo dõi qua
  bảng `schema_migrations`, chạy lại thì tự bỏ qua file đã áp dụng (idempotent).
- Format phản hồi API đã thống nhất theo code thật (`middleware/errorHandler.js`):
  - Thành công: `{ "success": true, "data": {...}, "error": null }`
  - Lỗi: `{ "success": false, "data": null, "error": { "code": "...", "message": "..." } }`

## Quyết định thiết kế đã chốt (đừng đảo ngược)

- Bidder và Seller là hai role tách biệt: `accounts` giữ đăng nhập chung, `bidders`
  và `sellers` là bảng con 1-1, một account chỉ thuộc một trong hai. Ví
  (`wallet_balance`, `wallet_held`) chỉ Bidder có.
- Thông báo (`notifications`) và tranh chấp (`disputes.reporter_id`) trỏ về
  `accounts`, vì cả hai role đều dùng.
- Tài khoản Thẩm định/Kho vận/Admin nằm ở `ops_accounts`, tách khỏi `accounts`.
- Đặt cọc để tham gia phiên (`auction_deposits`, 10% giá khởi điểm) tách khỏi lượt
  đặt giá (`bids`). Mỗi người cọc một lần cho mỗi phiên.
- Tiền là VND, kiểu BIGINT, không có phần thập phân.

## Luồng nghiệp vụ và quy tắc thời gian

1. Seller tạo `listings` (AI gợi ý giá khởi điểm vào `ai_suggested_price`).
2. Appraiser ghi `appraisals`: approve / reject / more_info. Nếu more_info, Seller
   bổ sung rồi nộp lại, sinh thêm dòng mới (không sửa dòng cũ).
3. Duyệt xong sinh `auctions` (1-1 với listing).
4. Bidder gọi tham gia (trừ cọc, ghi `auction_deposits` + `wallet_transactions` loại
   `deposit_hold`) rồi mới được đặt giá (`bids`). Bị vượt giá thì gửi thông báo.
5. Hết giờ: hệ thống chọn người thắng. Người thua: cọc `released` + `deposit_release`.
   Người thắng: sinh `orders` với `payment_deadline` = lúc thắng + 24 giờ, cọc chuyển
   `applied_to_payment`.
6. Quá `payment_deadline` mà chưa trả: `payment_status = expired`, cọc `forfeited`,
   huỷ giao dịch.
7. Seller gửi hàng tới kho. Kho: nhận (`warehouse_receipts`) -> kiểm -> đóng gói ->
   giao (`shipments`, `shipment_events`). Không khớp mô tả thì mở `disputes`
   (source = warehouse, reporter_id NULL).
8. Bidder xác nhận nhận hàng thì giải ngân cho Seller. Nếu không xác nhận, tự giải
   ngân khi qua `payout_deadline` (+72 giờ sau khi giao).
9. Admin: xử lý `flagged_auctions` (pause / terminate / verify / safe) và `disputes`
   (refund hoặc keep).

Hai "đồng hồ" cần một tiến trình nền kiểm tra: `orders.payment_deadline` (đang chờ
thanh toán) và `orders.payout_deadline` (đang chờ giải ngân). Cả hai đã có partial
index (`idx_orders_payment_deadline`, `idx_orders_payout_deadline`).

## Việc cần làm tiếp theo (theo thứ tự)

1. ~~`migrations/003_ops_password.sql`: thêm `password_hash` cho `ops_accounts`~~ — đã
   xong, kèm đăng nhập JWT (`/api/auth/*`, `/api/me`).
2. ~~Seed data tương đương dữ liệu giả trong `AppStore`~~ — đã xong: `npm run db:seed`
   (xem mục "Dữ liệu demo" trong `docs/architecture.md`).
3. Các thao tác ghi tiền và đổi trạng thái phải nằm trong một transaction ở phía
   server (tham gia phiên, đặt giá, thanh toán, đóng phiên, giải ngân, xử lý tranh
   chấp), dùng chung một client lấy từ pool. Với đặt giá, kiểm tra giá phải lớn hơn
   `current_price` + `bid_step` và khoá dòng `auctions` bằng `SELECT ... FOR UPDATE`
   để tránh hai người đặt cùng lúc.
4. Tách `AppStore` (Flutter) thành lớp repository có interface, giữ bản mock làm
   implementation mặc định để `flutter test` (nhất là `test/store_flow_test.dart`,
   nhóm "Luồng chính") vẫn chạy được không cần mạng. Thêm implementation gọi backend
   thật, bật bằng cấu hình.
5. Đặt giá thời gian thực: đẩy cập nhật giá/đếm ngược qua Socket.io thay cho vòng
   tick mỗi giây giả lập. **Lưu ý:** kết nối Socket.io hiện chưa xác thực ai kết nối
   — phải thêm xác thực (JWT) trước khi đẩy dữ liệu thật qua đó.
6. Chuyển logic "tick" tự động (đóng phiên, hết hạn thanh toán, tự giải ngân) sang
   job chạy phía server (ví dụ poll theo 2 index deadline ở trên mỗi vài giây).
7. Mật khẩu lưu dạng hash bằng `bcrypt` (đã cài sẵn trong `package.json`); dữ liệu
   seed dùng mật khẩu `123456` chỉ cho môi trường demo.

## Lưu ý vận hành

- `JWT_SECRET` bắt buộc có trong `.env`, không có giá trị mặc định — thiếu thì app
  throw ngay lúc khởi động (`src/config/env.js`). `npm run db:migrate` cũng đòi biến
  này dù không dùng tới, vì `db.js` nạp qua `env.js` — biết trước để đỡ bối rối khi
  mới clone repo.
- `DB_SSL=true` khi dùng Supabase; kết nối đang chấp nhận `rejectUnauthorized: false`
  (tạm ổn cho đồ án, không dùng cho production thật).
- `.env` không được commit (đã có trong `.gitignore`); mỗi người tự tạo theo
  `.env.example`. Nếu nén project gửi cho ai (kể cả AI assistant), nhớ loại bỏ `.env`
  ra khỏi file nén.
