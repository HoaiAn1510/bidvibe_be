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

`.env.example` liệt kê đúng các biến code đọc:

| Biến | Ý nghĩa |
|---|---|
| `PORT` | Cổng server. Không đặt thì `3000`; nhóm và app Flutter dùng `5000`. |
| `CORS_ORIGIN` | Nguồn được phép gọi API (mặc định `*`). |
| `NODE_ENV` | `production` thì lỗi 5xx chỉ trả "Lỗi hệ thống". |
| `DATABASE_URL` | Chuỗi kết nối Postgres. Với Supabase dùng chuỗi **Session pooler** (host `*.pooler.supabase.com`, cổng 5432, username dạng `postgres.<mã project>`). **Không** dùng Direct connection: nó chỉ có IPv6 nên nhiều mạng không kết nối được. |
| `DB_SSL` | `true` khi dùng Supabase. |
| `DB_POOL_MAX` | Tuỳ chọn, số kết nối tối đa của pool (bỏ trống thì 10; `.env.example` đặt 4). Session pooler của Supabase chỉ cho **15 kết nối cho cả database**, cộng dồn mọi bản đang chạy: `npm run dev` của từng người, `test:be1`, `test:be2` (hai bộ test tự dùng 4), mỗi tiến trình thêm 1 kết nối riêng cho `LISTEN` của `pause_listener`. Vượt giới hạn thì gặp lỗi `EMAXCONNSESSION`. Không đổi sang transaction pooler (cổng 6543) vì `LISTEN` không chạy qua đó. **Người làm app (FE) tự chạy backend riêng để thử: đặt `DB_POOL_MAX=2`.** |
| `JWT_SECRET` | Khoá ký token đăng nhập. Bắt buộc, không có giá trị mặc định. |
| `AUTO_PAYOUT_ENABLED` | `false` để tắt job tự giải ngân sau 72 giờ (mặc định bật). |
| `DEV_TOOLS` | `true` để mở `/api/dev` cho FE test nhanh (rút ngắn phiên, cho đơn quá hạn thanh toán; xem `docs/fe-quickstart.md` mục 6b). Mặc định `false`; **không bật trên máy chạy buổi demo**; không có tác dụng khi `NODE_ENV=production`. |
| `SUPABASE_URL` | Tuỳ chọn, dùng cho tải ảnh (`POST /api/uploads/images`). Dạng `https://<project-ref>.supabase.co` (dán cả đuôi `/rest/v1` cũng được, backend chỉ lấy phần gốc). |
| `SUPABASE_SERVICE_KEY` | Tuỳ chọn, khoá để backend ghi vào Storage: **Secret key** (`sb_secret_...`) hoặc khoá legacy **service_role** (`eyJ...`). Khoá này có toàn quyền trên project: chỉ đặt trong `.env` của backend, không đưa vào app, không commit, không dán vào log hay chat. |
| `STORAGE_BUCKET` | Tuỳ chọn, tên bucket chứa ảnh (mặc định `listing-photos`). Chưa có thì backend tự tạo bucket public, giới hạn 5 MB, chỉ nhận JPEG / PNG / WEBP. |

Thiếu `SUPABASE_URL` hoặc `SUPABASE_SERVICE_KEY` thì server vẫn chạy bình thường, chỉ route tải ảnh trả `503 UPLOAD_NOT_CONFIGURED` (app vẫn thêm ảnh được bằng URL có sẵn).

**Lấy key Storage**: Supabase Dashboard → chọn project → **Project Settings → API Keys**.
- Tab "API Keys": bấm tạo / hiện **Secret key** (`sb_secret_...`).
- Hoặc tab "Legacy API Keys": khoá **service_role**.
- Không dùng **Publishable** / **anon** key: hai khoá này không có quyền ghi Storage.
- `SUPABASE_URL`: Project Settings → **Data API** → Project URL.

Backend chỉ gửi header `apikey` với khoá `sb_secret_`, và thêm `Authorization: Bearer` khi khoá là JWT (`eyJ...`).

File `.env` chứa mật khẩu nên **không được đưa lên git** (đã có trong `.gitignore`). Mỗi người tự tạo `.env` của mình.

### Các lệnh npm

| Lệnh | Việc |
|---|---|
| `npm run dev` | Chạy server, tự khởi động lại khi sửa `src/` hoặc `.env` (`nodemon.json`). Khi khởi động in địa chỉ cho máy này, Android Emulator (`10.0.2.2`) và điện thoại thật (IP LAN); Ctrl+C trả kết nối database ngay |
| `npm start` | Chạy server (không tự khởi động lại) |
| `npm run db:migrate` | Chạy các file trong `migrations/` chưa được áp dụng |
| `npm run db:seed` | Thêm dữ liệu demo (BE1 + BE2), chạy lại nhiều lần không bị trùng. Mật khẩu demo `123456`: tài khoản demo đã có mà bị đổi mật khẩu thì được đặt lại về `123456` (chỉ tài khoản demo và 3 bot; số dư ví giữ nguyên). **Thử đổi mật khẩu / sửa hồ sơ (`POST /api/me/password`, `PATCH /api/me`) chỉ trên tài khoản tự đăng ký**, không dùng tài khoản demo |
| `npm run test:be1` | Kiểm thử end-to-end phần đấu giá/ví/tạm dừng/gian lận trên DB dùng chung (tài khoản `test_be1_*`, tự dọn) |
| `npm run test:be2` | Kiểm thử end-to-end phần BE2 qua HTTP thật (tài khoản `test_be2_<mã lần chạy>_*`, tự dọn) |
| `npm test` | Chạy cả `test:be1` và `test:be2` |
| `npm run test:clean [-- --dry-run]` | Dọn dữ liệu `test_be2_` bỏ sót từ lần chạy bị ngắt (chỉ lần chạy bắt đầu hơn 1 giờ trước; in danh sách trước khi xoá). Chỉ chạy khi cần |
| `npm run docs:check` | So route đăng ký trong `src/routes/` với `docs/api.md` (báo route thiếu / thừa). Chạy sau khi thêm hoặc sửa route |
| `npm run db:seed:live [-- --extend]` | Bảo đảm 9 phiên demo đang diễn ra trước buổi demo (xem bên dưới) |
| `npm run demo:bidbot -- --auction <id>` | 3 tài khoản bot trả giá một phiên để demo giá nhảy real-time (xem bên dưới) |

#### Chạy kiểm thử trên database dùng chung

Cả hai bộ test chạy trên Supabase dùng chung nên được viết để **không đụng dữ liệu thật**:

- Mọi dữ liệu test có tiền tố riêng: `test_be1_*` (BE1: email `test_be1_<mã lần chạy>_<tên>_<số>@be1test.local`, tin đăng `test_be1_<mã lần chạy>_item`) và `test_be2_*` (BE2: email `test_be2_<mã lần chạy>_<tên>@example.com`; họ tên, tên gian hàng, tiêu đề tin cũng bắt đầu bằng `test_be2_<mã lần chạy>_`).
- Test chỉ ghi/xoá các dòng đi ra từ những tài khoản có tiền tố đó; dữ liệu seed và dữ liệu của đồng đội không bị sửa hay xoá. Test BE1: cuối mỗi lần chạy (kể cả khi lỗi) chỉ dọn dữ liệu của **chính lần chạy đó** (theo mã lần chạy), đầu lần chạy chỉ dọn dữ liệu `test_be1_` bỏ dở từ hơn 30 phút trước — nên hai người chạy `test:be1` cùng lúc không xoá dữ liệu của nhau. Test BE2: cuối mỗi lần chạy (kể cả khi lỗi) cũng chỉ dọn dữ liệu của chính lần chạy đó; đầu lần chạy không dọn gì. Mọi thứ test BE2 cần ghi (tài khoản, tin, phiên, đơn, tranh chấp, cờ) đều tạo mới; job tự giải ngân trong test chỉ xét đơn của lần chạy đó. Hai `test:be2`, hoặc `test:be2` cùng `test:be1`, chạy song song được.
- Chạy được lúc đồng đội đang chạy server: scheduler của họ có thể đóng phiên test của bạn, test BE1 và BE2 đã chờ DB về đúng trạng thái. Nếu vẫn lỗi lặt vặt thì chạy lại.
- Nếu test bị ngắt giữa chừng (Ctrl+C), phần dở của test BE1 được dọn ở lần chạy `test:be1` đầu tiên sau 30 phút. Kiểm tra còn sót không: `SELECT count(*) FROM accounts WHERE email LIKE 'test\_be1\_%'`. Phần dở của test BE2 không tự dọn: chạy `npm run test:clean` (xem trước bằng `npm run test:clean -- --dry-run`).
- Cần database đã chạy `npm run db:migrate` (test BE1 cần migration `006`, `007`).

#### Làm mới dữ liệu demo trước buổi demo (`db:seed:live`)

```bash
npm run db:seed                      # lần đầu: tài khoản demo, Seller, Thẩm định viên, 3 bot
npm run db:seed:live                 # bảo đảm 9 phiên demo đang diễn ra (tạo bù phiên thiếu)
npm run db:seed:live -- --extend     # ... và đẩy giờ kết thúc các phiên demo đang chạy ra đủ thời lượng
```

- Bộ mẫu 9 phiên (`scripts/seed_live.js`): đủ 3 danh mục, giá khởi điểm và bước giá khác nhau, kết thúc sau ~3 phút (thử chống chốt phút chót), 2 / 4 / 6 / 10 / 20 giờ, 28 / 36 / 48 giờ. Mỗi tin 2 ảnh (Wikimedia Commons), người bán là Seller demo.
- Phiên đi đúng đường như phiên thật: tin chờ thẩm định → Thẩm định viên demo duyệt → `createAuctionForListing`.
- Chạy lại nhiều lần không tạo trùng: mỗi mẫu tối đa một phiên đang chạy, chỉ tạo bù mẫu đang thiếu (ví dụ phiên ~3 phút đã hết giờ). Không sửa / xoá phiên đã kết thúc, đơn, cọc hay giao dịch. Từ chối chạy khi `NODE_ENV=production`.

#### Giả lập người đấu giá khi demo (`demo:bidbot`)

Cho 3 tài khoản **bot riêng** (`bot1@bidvibe.demo`, `bot2@bidvibe.demo`, `bot3@bidvibe.demo`, mật khẩu `123456`, ví nạp sẵn 50.000.000đ, tạo bởi `db:seed` / `db:seed:live`) lần lượt trả giá một phiên, để màn hình app thấy giá nhảy qua Socket.io:

```bash
npm run dev                                                            # terminal 1
npm run demo:bidbot -- --auction 871 --interval 5 --max 10             # terminal 2; Ctrl+C để dừng
npm run demo:bidbot -- --auction 871 --only-outbid --stop-before 120   # chỉ vượt giá khi người khác dẫn đầu
```

| Tuỳ chọn | Mặc định | Ý nghĩa |
|---|---|---|
| `--auction <id>` | bắt buộc | Id phiên, lấy từ `GET /api/auctions?status=live` |
| `--interval <giây>` | 5 | Khoảng cách giữa hai lượt |
| `--max <n>` | 10 | Số lượt tối đa |
| `--stop-before <giây>` | 60 | Không trả giá khi phiên còn ít hơn chừng này giây (hạn chế bot thắng) |
| `--only-outbid` | tắt | Chỉ trả giá khi **người khác** (không phải bot) đang dẫn đầu |
| `--bots a,b` | cả 3 bot | Chọn bớt bot; chỉ nhận email bot, email khác → từ chối |
| `--base <url>` | `http://localhost:5000` | Địa chỉ server |

- **Chỉ dùng 3 tài khoản bot**, không bao giờ dùng tài khoản demo của người dùng; thiếu tài khoản bot thì từ chối (chạy `npm run db:seed:live` để tạo).
- Đi qua API thật (đăng nhập, đặt cọc nếu chưa cọc, `POST /api/bids` với `increment` = bước giá), in ra từng bước. Dừng khi đủ `--max` lượt, phiên hết giờ hoặc còn dưới `--stop-before` giây, không bot nào đủ tiền, hoặc Ctrl+C. Từ chối chạy khi `NODE_ENV=production`.
- Chỉ trả giá khi số dư còn đủ trả đơn nếu thắng (giá + phí 5% + vận chuyển − cọc), nên không vượt số dư.
- **Bot vẫn có thể thắng** nếu đang dẫn đầu lúc phiên kết thúc (ví dụ không ai vượt lại): bot có đơn chờ thanh toán, quá 24 giờ thì mất cọc (chỉ ví bot bị trừ). Dùng `--only-outbid` để bot chỉ "đẩy giá" khi người thật đang dẫn đầu.

## Cấu trúc thư mục

```
migrations/        # file SQL tạo/đổi cấu trúc database (001 ... 008)
scripts/           # migrate, seed (seed_demo.js BE1, seed.js BE2), test_be1, test_be2 (+ test_be2_clean), docs_check
docs/              # tài liệu (xem mục Tài liệu)
src/
├── config/        # kết nối DB (db.js), biến môi trường (env.js)
├── middleware/    # auth (requireAuth, requireRole), error handler
├── models/        # truy vấn của BE1 (auction, bid, wallet)
├── routes/        # định tuyến API
├── services/      # logic nghiệp vụ chính (BE2 truy vấn trực tiếp trong service)
├── sockets/       # xử lý real-time (Socket.io)
├── utils/         # validate.js: kiểm tra đầu vào dùng chung
└── app.js         # entry point
```

## Cơ sở dữ liệu

Schema gốc nằm trong `migrations/001_init_schema.sql` (23 bảng nghiệp vụ), các migration sau chỉ thêm: `003` mật khẩu tài khoản nội bộ, `004` loại giao dịch ví mất cọc, `005` bảng `addresses` và `orders.shipping_address_id`, `006` (BE1) `auctions.paused_at` + trigger đóng băng đồng hồ khi tạm dừng, unique index chặn cờ gian lận `pending` trùng, `007` (BE1) trigger tạm dừng gửi `pg_notify` để server phát Socket.io, `008` (BE2) cột `notifications.data` (id liên quan để app mở đúng màn khi bấm thông báo). Thư mục `migrations/` là nguồn sự thật cho cấu trúc dữ liệu. Sơ đồ quan hệ xem trong Supabase: **Database → Schema Visualizer**.

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

- **Không sửa file migration đã chạy.** Muốn đổi cấu trúc thì thêm file mới với số kế tiếp (hiện tại là `009_...sql`). Chỉ một người chạy `npm run db:migrate` mỗi lần có file mới, rồi báo người còn lại.
- **RLS đã bật cho mọi bảng và không có policy nào** (`002_enable_rls.sql`), để chặn truy cập qua API công khai của Supabase. Backend kết nối bằng tài khoản `postgres` nên bỏ qua RLS và vẫn đọc ghi bình thường. Bảng mới thêm sau này cũng phải bật RLS trong chính file migration của nó.
- **Thao tác đụng tiền hoặc đổi trạng thái nhiều bảng phải nằm trong một giao dịch** (`BEGIN ... COMMIT`) dùng chung một kết nối lấy từ pool. Đặt giá phải khoá dòng phiên bằng `SELECT ... FOR UPDATE` để hai người không đặt trùng.
- Không tự cộng/trừ số dư. Mọi thay đổi ví đi qua service ví (xem bên dưới) để luôn có dòng trong `wallet_transactions`.

## Phân chia công việc

| Domain | Phụ trách | Phạm vi |
|---|---|---|
| Auction Core | BE1 | `auction.*`, `bid.*`, `wallet.*`, `order.routes.js`, `fraud_detection.js`, `scheduler.js`, `sockets/` |
| Marketplace Operations | BE2 | `auth.*`, `listing.*`, `appraisal.*`, `ai.*` / `ai_price_suggestion.js`, `address.*`, `fulfilment.*`, `payout_service.js`, `warehouse.*`, `dispute.*`, `admin.*`, `notification.*`, `chat.*`, `utils/validate.js` |

Danh sách file đầy đủ theo domain: [`docs/architecture.md`](docs/architecture.md#phân-chia-domain-file-thật-trong-src).

Hai domain nối nhau qua các điểm sau, cần tôn trọng:

- **Ví chỉ BE1 viết** (`wallet.*`), gồm các hàm giữ cọc, hoàn cọc, thanh toán, hoàn tiền; mỗi hàm nhận `client` để nằm chung giao dịch của nơi gọi. BE2 muốn hoàn tiền (ví dụ Admin xử lý tranh chấp) thì gọi hàm ví của BE1, không tự sửa số dư.
- **Thông báo do BE2 viết** (hàm tạo thông báo, ghi bảng `notifications` và đẩy qua Socket.io nếu người nhận đang online). BE1 gọi hàm này khi có người bị vượt giá hoặc thắng phiên.
- **Tạo phiên đấu giá:** khi Thẩm định duyệt một tin đăng, BE2 gọi một hàm do BE1 cung cấp để sinh `auctions`; BE2 không tự ghi vào bảng `auctions`.
- **Đơn hàng (`orders`):** BE1 tạo khi phiên kết thúc; BE2 đọc và cập nhật phần kho, giao hàng, giải ngân. Địa chỉ giao hàng (`orders.shipping_address_id`) do người mua chọn qua API của BE2 (`POST /api/orders/:id/shipping-address`), luồng thanh toán của BE1 không đổi; kho không gửi được hàng khi đơn chưa có địa chỉ (`409 ORDER_NO_ADDRESS`).
- **Đăng nhập:** `auth.*` do BE2 phụ trách. Bidder / Seller đăng nhập qua `accounts.password_hash`, Thẩm định / Kho vận / Admin qua `ops_accounts.password_hash` (thêm ở migration `003`); tài khoản ops do Admin tạo qua `POST /api/admin/ops-accounts`.
- **Scheduler chỉ một backend làm việc tại một thời điểm:** mỗi lượt tick (5 giây) lấy khoá advisory `pg_try_advisory_lock(0x424944565343)` trên một client của pool; không lấy được (backend khác đang chạy lượt của họ) thì bỏ lượt, xong thì `pg_advisory_unlock` rồi trả client. Khoá phiên tự nhả khi kết nối đóng, nên backend giữ khoá bị tắt thì lượt sau backend khác làm tiếp. Log một dòng khi backend bắt đầu / thôi làm "scheduler chính" (không log mỗi 5 giây). Mỗi lượt tick tốn thêm 1 kết nối trong pool lúc chạy (người làm app đặt `DB_POOL_MAX=2` vẫn đủ).
- **Tự giải ngân:** job của BE2 (`payout_service.releaseOverduePayouts`) chạy chung vòng `scheduler.js` của BE1, tắt bằng `AUTO_PAYOUT_ENABLED=false`.

## Tài liệu

| File | Dành cho | Nội dung |
|---|---|---|
| [`docs/api.md`](docs/api.md) | App, backend | Toàn bộ REST API theo nghiệp vụ: quy ước, vai trò, từng endpoint (body, phản hồi mẫu thật, lỗi), bảng enum, bảng mã lỗi. Khớp 100% với route (`npm run docs:check`) |
| [`docs/fe-quickstart.md`](docs/fe-quickstart.md) | App Flutter | Nối nhanh: chạy backend, địa chỉ gốc theo môi trường, tài khoản demo, màn hình nào gọi endpoint nào, token và lỗi, Socket.io bằng Dart, chạy thử bằng curl |
| [`docs/socket.md`](docs/socket.md) | App, backend | Sự kiện Socket.io: kết nối, phòng, dữ liệu từng sự kiện |
| [`docs/mainflow.md`](docs/mainflow.md) | Cả nhóm, giảng viên | Luồng nghiệp vụ từ đăng ký đến giải ngân, sơ đồ, luồng tiền, luồng thời gian, việc còn thiếu |
| [`docs/architecture.md`](docs/architecture.md) | Backend | Quy ước, phân chia BE1 / BE2 theo file, hàm hai bên gọi nhau, quyết định thiết kế |
| [`docs/test-be2.md`](docs/test-be2.md) | Backend | Kết quả kiểm thử BE2 (sinh tự động bởi `node scripts/test_be2.js --report docs/test-be2.md`) |
| [`docs/bidvibe.postman_collection.json`](docs/bidvibe.postman_collection.json), [`docs/bidvibe.postman_environment.json`](docs/bidvibe.postman_environment.json) | App, backend | Bộ request Postman cho 65 route; đăng nhập tự lưu token |

## Quy ước Git

- Nhánh chính: `main` (ổn định), `develop` (tích hợp)
- Nhánh tính năng: `feature/be1-...` hoặc `feature/be2-...`
- Merge vào `develop` qua Pull Request, cần review trước khi merge
- Không commit `.env`, chuỗi kết nối hay mật khẩu