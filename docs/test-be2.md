# Kết quả kiểm thử BE2

> Cập nhật: 2026-10-12. File này được sinh tự động, không sửa tay.

Chạy lúc 2026-10-12T13:53:14.334Z bằng `node scripts/test_be2.js --report docs/test-be2.md`.
Gọi API thật qua HTTP (server chạy trong tiến trình, cổng ngẫu nhiên) trên database thật dùng chung.

**Mã lần chạy và dọn dữ liệu.** Mỗi lần chạy sinh một mã riêng (thời điểm bắt đầu dạng base36 + 3 ký tự ngẫu nhiên). Email có dạng `test_be2_<mã lần chạy>_<tên>@example.com`; họ tên, tên gian hàng, tiêu đề tin cũng bắt đầu bằng `test_be2_<mã lần chạy>_`. Cuối lần chạy (kể cả khi lỗi) chỉ xoá các dòng đi ra từ tài khoản của chính lần đó, nên hai `test:be2`, hoặc `test:be2` cùng `test:be1`, chạy song song được. Mọi dữ liệu cần ghi đều tạo mới; dữ liệu demo chỉ được đọc. Dữ liệu bỏ sót do lần chạy bị ngắt: `npm run test:clean` (xem trước bằng `npm run test:clean -- --dry-run`), chỉ xoá tài khoản `test_be2_` của lần chạy bắt đầu hơn 1 giờ trước.

Server test không chạy scheduler nên hai mốc thời gian được ép: đóng phiên (đặt `ends_at` về quá khứ rồi gọi `closeAuction` của BE1) và tự giải ngân (đặt `payout_deadline` về quá khứ rồi gọi `releaseOverduePayouts` chỉ cho đơn của lần chạy). Token trong phản hồi được che.

**Kết quả: ĐẠT 246 bước**

## 1. Đăng ký, đăng nhập, tài khoản nội bộ

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Đăng ký với mật khẩu quá ngắn bị từ chối | POST | `/api/auth/register` | 400 | VALIDATION_ERROR: Mật khẩu tối thiểu 6 ký tự |
| Đăng ký với email sai định dạng bị từ chối | POST | `/api/auth/register` | 400 | VALIDATION_ERROR: Email không đúng định dạng |
| Body JSON hỏng trả INVALID_JSON | POST | `/api/auth/login` | 400 | INVALID_JSON: Dữ liệu gửi lên không phải JSON hợp lệ |
| Seller đăng ký | POST | `/api/auth/register` | 201 | role=seller, token=(che) |
| Bidder 1 đăng ký | POST | `/api/auth/register` | 201 | role=bidder, token=(che) |
| Bidder 2 đăng ký | POST | `/api/auth/register` | 201 | role=bidder, token=(che) |
| Đăng ký trùng email | POST | `/api/auth/register` | 409 | EMAIL_TAKEN: Email này đã được đăng ký |
| Đăng nhập sai mật khẩu | POST | `/api/auth/login` | 401 | INVALID_CREDENTIALS: Email hoặc mật khẩu không đúng |
| Bidder 1 đăng nhập | POST | `/api/auth/login` | 200 | role=bidder, token=(che) |
| Admin đăng nhập ops | POST | `/api/auth/ops/login` | 200 | role=admin, token=(che) |
| Admin tạo tài khoản Thẩm định | POST | `/api/admin/ops-accounts` | 201 | {"id":"423","name":"test_be2_mv5b9sqvwc4_Thẩm định","email":"test_be2_mv5b9sqvwc4_appraiser@example.com","role":"appraiser","status":"active |
| Admin tạo tài khoản Kho | POST | `/api/admin/ops-accounts` | 201 | {"id":"424","name":"test_be2_mv5b9sqvwc4_Kho","email":"test_be2_mv5b9sqvwc4_warehouse@example.com","role":"warehouse","status":"active","wee |
| Tạo ops trùng email | POST | `/api/admin/ops-accounts` | 409 | EMAIL_TAKEN: Email này đã được dùng cho tài khoản nội bộ khác |
| Thẩm định đăng nhập | POST | `/api/auth/ops/login` | 200 | role=appraiser, token=(che) |
| Kho đăng nhập | POST | `/api/auth/ops/login` | 200 | role=warehouse, token=(che) |
| Seller gọi API Admin bị chặn | GET | `/api/admin/dashboard` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |

## 2. Seller đăng tin, Thẩm định yêu cầu bổ sung rồi duyệt

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Danh mục | GET | `/api/categories` | 200 | shoes, elec, antique |
| AI gợi ý giá | POST | `/api/ai/suggest-price` | 200 | basis=history, gợi ý 2200000 |
| Tạo tin (nháp) | POST | `/api/listings` | 201 | id=2484, status=draft |
| Gửi thẩm định khi chưa có ảnh | POST | `/api/listings/2484/submit` | 400 | PHOTOS_REQUIRED: Cần ít nhất một ảnh trước khi gửi thẩm định |
| Thêm ảnh (URL) | POST | `/api/listings/2484/photos` | 201 | 2 ảnh |
| Gửi thẩm định | POST | `/api/listings/2484/submit` | 200 | status=pending_appraisal |
| Sửa khi đang chờ thẩm định | PATCH | `/api/listings/2484` | 409 | INVALID_STATE: Không thể sửa khi tin đăng đang ở trạng thái "chờ thẩm định" |
| Hàng chờ thẩm định có tin mới | GET | `/api/appraisals/queue?limit=100&offset=0` | 200 | có tin test: true |
| Yêu cầu bổ sung | POST | `/api/appraisals/2484/decision` | 201 | listing=needs_info |
| Duyệt khi tin đang chờ bổ sung | POST | `/api/appraisals/2484/decision` | 409 | INVALID_STATE: Không thể thẩm định khi tin đăng đang ở trạng thái "cần bổ sung" |
| Seller sửa mô tả (needs_info) | PATCH | `/api/listings/2484` | 200 | {"id":"2484","title":"test_be2_mv5b9sqvwc4_Máy nghe nhạc","category":"elec","description":"Đã bổ sung ảnh số seri","condition":"Như mới","st |
| Seller thêm ảnh số seri | POST | `/api/listings/2484/photos` | 201 | {"id":"2484","title":"test_be2_mv5b9sqvwc4_Máy nghe nhạc","category":"elec","description":"Đã bổ sung ảnh số seri","condition":"Như mới","st |
| Seller nộp lại | POST | `/api/listings/2484/resubmit` | 200 | status=pending_appraisal |
| Thẩm định duyệt -> sinh phiên | POST | `/api/appraisals/2484/decision` | 201 | listing=live, auctionId=2473 |
| Lịch sử thẩm định (2 dòng, không sửa dòng cũ) | GET | `/api/appraisals/2484` | 200 | more_info -> approve |
| Seller nhận thông báo duyệt | GET | `/api/notifications` | 200 | listing_approved, listing_needs_info |

## 3. Bidder nạp ví, đặt cọc, trả giá; phiên kết thúc

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bidder 1 nạp ví | POST | `/api/wallet/topup` | 201 | balance=10000000 |
| Bidder 2 nạp ví | POST | `/api/wallet/topup` | 201 | balance=10000000 |
| Đặt giá khi chưa cọc | POST | `/api/bids` | 403 | DEPOSIT_REQUIRED: Cần đặt cọc tham gia trước khi đặt giá |
| Bidder 1 đặt cọc | POST | `/api/auctions/2473/join` | 201 | cọc 100000 |
| Bidder 2 đặt cọc | POST | `/api/auctions/2473/join` | 201 | cọc 100000 |
| Bidder 1 trả giá | POST | `/api/bids` | 201 | {"bidId":"3608","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-13T13:52:13.310Z","extended":false} |
| Bidder 2 trả giá cao hơn | POST | `/api/bids` | 201 | {"bidId":"3609","currentPrice":1100000,"bidCount":2,"endsAt":"2026-10-13T13:52:13.310Z","extended":false} |
| Bidder 1 trả giá thấp hơn mức tối thiểu | POST | `/api/bids` | 400 | BID_TOO_LOW: Giá tối thiểu là 1.150.000đ |
| Bidder 1 trả giá | POST | `/api/bids` | 201 | {"bidId":"3610","currentPrice":1150000,"bidCount":3,"endsAt":"2026-10-13T13:52:13.310Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) chọn người thắng | — | `—` | — | orderId=815 |
| Người thua được hoàn cọc về ví | — | `—` | — | Bidder 2: held 100000 -> 0, balance 9900000 -> 10000000 |

## 4. Địa chỉ giao hàng của người mua

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bidder 1 chưa có địa chỉ | GET | `/api/addresses` | 200 | 0 địa chỉ |
| Seller không dùng API địa chỉ | GET | `/api/addresses` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| Thêm địa chỉ với số điện thoại sai | POST | `/api/addresses` | 400 | VALIDATION_ERROR: Số điện thoại không hợp lệ |
| Thêm địa chỉ thiếu địa chỉ | POST | `/api/addresses` | 400 | VALIDATION_ERROR: Địa chỉ không được để trống |
| Thêm địa chỉ đầu tiên (tự thành mặc định) | POST | `/api/addresses` | 201 | id=316, isDefault=true |
| Thêm địa chỉ thứ hai | POST | `/api/addresses` | 201 | id=317, isDefault=false |
| Đặt địa chỉ thứ hai làm mặc định | POST | `/api/addresses/317/default` | 200 | isDefault=true |
| Danh sách sau khi đổi mặc định | GET | `/api/addresses` | 200 | 317(mặc định), 316 |
| Sửa địa chỉ (chưa đơn nào dùng, sửa tại chỗ) | PATCH | `/api/addresses/316` | 200 | id=316, 45A Võ Văn Tần |
| Bidder 2 sửa địa chỉ của Bidder 1 | PATCH | `/api/addresses/316` | 404 | NOT_FOUND: Không tìm thấy địa chỉ |
| Bidder 2 xoá địa chỉ của Bidder 1 | DELETE | `/api/addresses/316` | 404 | NOT_FOUND: Không tìm thấy địa chỉ |
| Bidder 2 đặt mặc định địa chỉ của Bidder 1 | POST | `/api/addresses/316/default` | 404 | NOT_FOUND: Không tìm thấy địa chỉ |

## 5. Thanh toán, gửi kho, kho xử lý, xác nhận, giải ngân

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Đơn thắng của Bidder 1 | GET | `/api/orders/mine` | 200 | totalDue=1248000, amountToPay=1148000 |
| Gửi kho khi chưa thanh toán | POST | `/api/orders/815/ship-to-warehouse` | 409 | INVALID_STATE: Đơn chưa được thanh toán, chưa thể gửi hàng |
| Bidder 1 thanh toán bằng ví | POST | `/api/orders/815/pay` | 200 | paymentStatus=paid |
| Seller xem đơn đã bán | GET | `/api/orders/selling?stage=awaiting_seller_shipment` | 200 | 1 đơn chờ gửi kho |
| Bidder không gọi được API của Seller | GET | `/api/orders/selling` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| Kho nhận hàng khi Seller chưa gửi | POST | `/api/warehouse/orders/815/receive` | 409 | INVALID_STATE: Người bán chưa báo gửi hàng về kho |
| Seller gửi hàng về kho | POST | `/api/orders/815/ship-to-warehouse` | 200 | stage=in_transit_to_warehouse, mã BV-121026-0815 |
| Seller gửi lần hai | POST | `/api/orders/815/ship-to-warehouse` | 409 | ALREADY_SHIPPED: Đơn này đã được báo gửi về kho |
| Kho xem đơn đang về | GET | `/api/warehouse/orders?stage=in_transit_to_warehouse&limit=100&offset=0` | 200 | có đơn test: true |
| Đóng gói trước khi nhận | POST | `/api/warehouse/orders/815/pack` | 409 | INVALID_STATE: Chỉ đóng gói được đơn đã kiểm đạt |
| Kho nhận hàng | POST | `/api/warehouse/orders/815/receive` | 200 | stage=inspecting |
| Kiểm hàng: khớp mô tả | POST | `/api/warehouse/orders/815/inspect` | 200 | stage=inspected |
| Gửi đi trước khi đóng gói | POST | `/api/warehouse/orders/815/ship` | 409 | INVALID_STATE: Chỉ gửi đi được đơn đã đóng gói |
| Đóng gói | POST | `/api/warehouse/orders/815/pack` | 200 | stage=packed |
| Gửi đi khi đơn chưa có địa chỉ | POST | `/api/warehouse/orders/815/ship` | 409 | ORDER_NO_ADDRESS: Người mua chưa chọn địa chỉ giao hàng cho đơn này, chưa thể gửi đi |
| Bidder 2 gắn địa chỉ vào đơn của Bidder 1 | POST | `/api/orders/815/shipping-address` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Seller gắn địa chỉ vào đơn | POST | `/api/orders/815/shipping-address` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| Bidder 1 chọn địa chỉ giao hàng | POST | `/api/orders/815/shipping-address` | 200 | 12 Phố Huế, Hà Nội |
| Bidder 1 đổi sang địa chỉ khác (còn trước khi gửi) | POST | `/api/orders/815/shipping-address` | 200 | 45A Võ Văn Tần, TP.HCM |
| Kho thấy địa chỉ giao hàng | GET | `/api/warehouse/orders?stage=packed&limit=100&offset=0` | 200 | Người mua Một · 0903 112 233 · 45A Võ Văn Tần, TP.HCM |
| Gửi cho đơn vị vận chuyển | POST | `/api/warehouse/orders/815/ship` | 200 | stage=shipped, mã GHNTEST0001 |
| Đổi địa chỉ khi đơn đã gửi đi | POST | `/api/orders/815/shipping-address` | 409 | ALREADY_SHIPPED: Đơn đã được gửi đi, không thể đổi địa chỉ giao hàng |
| Bidder xác nhận khi chưa giao | POST | `/api/orders/815/confirm-delivery` | 409 | NOT_DELIVERED: Đơn chưa được giao, chưa thể xác nhận |
| Giao thành công | POST | `/api/warehouse/orders/815/deliver` | 200 | stage=delivered, payoutDeadline=2026-10-15T13:52:28.491Z |
| Bidder 2 xác nhận đơn không phải của mình | POST | `/api/orders/815/confirm-delivery` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Bidder 1 xác nhận đã nhận hàng | POST | `/api/orders/815/confirm-delivery` | 200 | stage=completed, payoutStatus=released |
| Xác nhận lần hai | POST | `/api/orders/815/confirm-delivery` | 409 | ALREADY_CONFIRMED: Bạn đã xác nhận nhận hàng cho đơn này |
| Theo dõi đơn (người mua) | GET | `/api/orders/815/tracking` | 200 | packing -> shipped -> delivered; giao tới 45A Võ Văn Tần |
| Theo dõi đơn (người bán, không thấy địa chỉ) | GET | `/api/orders/815/tracking` | 200 | có shippingAddress: false |
| Sửa địa chỉ đơn đã gửi đang dùng (tạo bản mới) | PATCH | `/api/addresses/316` | 200 | id cũ=316, id mới=318 |
| Đơn đã gửi vẫn giữ địa chỉ cũ | GET | `/api/orders/815/tracking` | 200 | 316: 45A Võ Văn Tần |
| Xoá địa chỉ (xoá mềm) | DELETE | `/api/addresses/318` | 200 | deleted=true |
| Danh sách sau khi xoá | GET | `/api/addresses` | 200 | 1 địa chỉ, mặc định 317 |
| Đơn đã gửi vẫn đọc được địa chỉ sau khi xoá | GET | `/api/orders/815/tracking` | 200 | 45A Võ Văn Tần |
| Seller nhận thông báo giải ngân | GET | `/api/notifications` | 200 | payout, sold, listing_approved, listing_needs_info |

## 6. Tranh chấp do Kho mở (hàng không khớp) -> Admin hoàn tiền

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "test_be2_mv5b9sqvwc4_Bình gốm (tranh chấp)" | POST | `/api/listings` | 201 | id=2485 |
| Thêm ảnh | POST | `/api/listings/2485/photos` | 201 | {"id":"2485","title":"test_be2_mv5b9sqvwc4_Bình gốm (tranh chấp)","category":"antique","description":null,"condition":null,"startingPrice":1 |
| Gửi thẩm định | POST | `/api/listings/2485/submit` | 200 | {"id":"2485","title":"test_be2_mv5b9sqvwc4_Bình gốm (tranh chấp)","category":"antique","description":null,"condition":null,"startingPrice":1 |
| Duyệt | POST | `/api/appraisals/2485/decision` | 201 | auctionId=2474 |
| Đặt cọc | POST | `/api/auctions/2474/join` | 201 | {"depositId":"2176","deposit":100000,"balanceAfter":9900000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"3611","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-13T13:52:33.962Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=816 |
| Thanh toán bằng ví | POST | `/api/orders/816/pay` | 200 | {"orderId":"816","paymentStatus":"paid","totalDue":1143000,"balanceAfter":8857000} |
| Seller gửi hàng về kho | POST | `/api/orders/816/ship-to-warehouse` | 200 | {"id":"816","auctionId":"2474","title":"test_be2_mv5b9sqvwc4_Bình gốm (tranh chấp)","category":"antique","finalPrice":1050000,"paymentStatus |
| Kho nhận hàng | POST | `/api/warehouse/orders/816/receive` | 200 | {"id":"816","auctionId":"2474","title":"test_be2_mv5b9sqvwc4_Bình gốm (tranh chấp)","category":"antique","finalPrice":1050000,"paymentStatus |
| Kiểm hàng: không khớp thiếu ghi chú | POST | `/api/warehouse/orders/816/inspect` | 400 | VALIDATION_ERROR: Ghi chú kiểm hàng không được để trống |
| Kiểm hàng: không khớp -> tự mở tranh chấp | POST | `/api/warehouse/orders/816/inspect` | 200 | stage=inspection_failed, payoutStatus=disputed |
| Không đóng gói được đơn đang tranh chấp | POST | `/api/warehouse/orders/816/pack` | 409 | INVALID_STATE: Chỉ đóng gói được đơn đã kiểm đạt |
| Bidder mở thêm tranh chấp khi đã có | POST | `/api/disputes` | 409 | DISPUTE_OPEN: Đơn này đang có tranh chấp chờ xử lý |
| Admin xem tranh chấp đang mở | GET | `/api/admin/disputes?status=open&limit=100&offset=0` | 200 | có tranh chấp của đơn test: true |
| Admin phán quyết hoàn tiền | POST | `/api/admin/disputes/145/resolve` | 200 | status=resolved, resolution=refund, ký quỹ 1143000 |
| Ví người mua được hoàn qua wallet_service.refund (BE1) | — | `—` | — | balance 8857000 -> 10000000; wallet_transactions: refund 1143000, balance_after 10000000 |
| Phán quyết lần hai | POST | `/api/admin/disputes/145/resolve` | 409 | ALREADY_RESOLVED: Tranh chấp này đã được xử lý |

## 7. Tranh chấp do Bidder mở sau khi giao -> Admin giữ nguyên, giải ngân

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)" | POST | `/api/listings` | 201 | id=2486 |
| Thêm ảnh | POST | `/api/listings/2486/photos` | 201 | {"id":"2486","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","description":null,"condition":null,"startingPrice":10 |
| Gửi thẩm định | POST | `/api/listings/2486/submit` | 200 | {"id":"2486","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","description":null,"condition":null,"startingPrice":10 |
| Duyệt | POST | `/api/appraisals/2486/decision` | 201 | auctionId=2475 |
| Đặt cọc | POST | `/api/auctions/2475/join` | 201 | {"depositId":"2177","deposit":100000,"balanceAfter":8652000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"3612","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-13T13:52:41.348Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=817 |
| Thanh toán bằng ví | POST | `/api/orders/817/pay` | 200 | {"orderId":"817","paymentStatus":"paid","totalDue":1143000,"balanceAfter":7609000} |
| Seller gửi hàng về kho | POST | `/api/orders/817/ship-to-warehouse` | 200 | {"id":"817","auctionId":"2475","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Kho nhận hàng | POST | `/api/warehouse/orders/817/receive` | 200 | {"id":"817","auctionId":"2475","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Kiểm hàng: khớp | POST | `/api/warehouse/orders/817/inspect` | 200 | {"id":"817","auctionId":"2475","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Đóng gói | POST | `/api/warehouse/orders/817/pack` | 200 | {"id":"817","auctionId":"2475","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Bidder lấy địa chỉ mặc định | GET | `/api/addresses` | 200 | 1 địa chỉ |
| Bidder chọn địa chỉ giao hàng | POST | `/api/orders/817/shipping-address` | 200 | {"id":"817","auctionId":"2475","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Gửi đi | POST | `/api/warehouse/orders/817/ship` | 200 | {"id":"817","auctionId":"2475","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Giao thành công | POST | `/api/warehouse/orders/817/deliver` | 200 | {"id":"817","auctionId":"2475","title":"test_be2_mv5b9sqvwc4_Đồng hồ (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Bidder 2 mở tranh chấp đơn của người khác | POST | `/api/disputes` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Bidder mở tranh chấp | POST | `/api/disputes` | 201 | source=bidder, payoutStatus=disputed |
| Xác nhận nhận hàng khi đang tranh chấp | POST | `/api/orders/817/confirm-delivery` | 409 | DISPUTE_OPEN: Đơn đang có tranh chấp, chờ Admin xử lý |
| Admin phán quyết giữ nguyên | POST | `/api/admin/disputes/146/resolve` | 200 | resolution=keep, payoutStatus=released |

## 8. Tự giải ngân sau 72 giờ

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "test_be2_mv5b9sqvwc4_Radio (tự giải ngân)" | POST | `/api/listings` | 201 | id=2487 |
| Thêm ảnh | POST | `/api/listings/2487/photos` | 201 | {"id":"2487","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","description":null,"condition":null,"startingPrice":10 |
| Gửi thẩm định | POST | `/api/listings/2487/submit` | 200 | {"id":"2487","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","description":null,"condition":null,"startingPrice":10 |
| Duyệt | POST | `/api/appraisals/2487/decision` | 201 | auctionId=2476 |
| Đặt cọc | POST | `/api/auctions/2476/join` | 201 | {"depositId":"2178","deposit":100000,"balanceAfter":7509000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"3613","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-13T13:52:49.181Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=818 |
| Thanh toán bằng ví | POST | `/api/orders/818/pay` | 200 | {"orderId":"818","paymentStatus":"paid","totalDue":1143000,"balanceAfter":6466000} |
| Seller gửi hàng về kho | POST | `/api/orders/818/ship-to-warehouse` | 200 | {"id":"818","auctionId":"2476","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Kho nhận hàng | POST | `/api/warehouse/orders/818/receive` | 200 | {"id":"818","auctionId":"2476","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Kiểm hàng: khớp | POST | `/api/warehouse/orders/818/inspect` | 200 | {"id":"818","auctionId":"2476","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Đóng gói | POST | `/api/warehouse/orders/818/pack` | 200 | {"id":"818","auctionId":"2476","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Bidder lấy địa chỉ mặc định | GET | `/api/addresses` | 200 | 1 địa chỉ |
| Bidder chọn địa chỉ giao hàng | POST | `/api/orders/818/shipping-address` | 200 | {"id":"818","auctionId":"2476","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Gửi đi | POST | `/api/warehouse/orders/818/ship` | 200 | {"id":"818","auctionId":"2476","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Giao thành công | POST | `/api/warehouse/orders/818/deliver` | 200 | {"id":"818","auctionId":"2476","title":"test_be2_mv5b9sqvwc4_Radio (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus" |
| Chưa tới hạn thì job không giải ngân | — | `—` | — | đơn vẫn payout_status = pending |
| Đơn đã tự giải ngân | GET | `/api/orders/818/tracking` | 200 | stage=completed, payoutStatus=released, deliveredConfirmedAt=null |

## 9. Phiên bị gắn cờ (fraud_detection của BE1) -> Admin xử lý

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin | POST | `/api/listings` | 201 | {"id":"2488","title":"test_be2_mv5b9sqvwc4_Máy ảnh (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000," |
| Thêm ảnh | POST | `/api/listings/2488/photos` | 201 | {"id":"2488","title":"test_be2_mv5b9sqvwc4_Máy ảnh (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000," |
| Gửi thẩm định | POST | `/api/listings/2488/submit` | 200 | {"id":"2488","title":"test_be2_mv5b9sqvwc4_Máy ảnh (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000," |
| Duyệt | POST | `/api/appraisals/2488/decision` | 201 | {"appraisalId":"472","decidedAt":"2026-10-12T13:52:56.926Z","listingId":"2488","decision":"approve","listingStatus":"live","auctionId":"2477 |
| Bidder 1 đặt cọc | POST | `/api/auctions/2477/join` | 201 | {"depositId":"2179","deposit":100000,"balanceAfter":6366000} |
| Bidder 2 đặt cọc | POST | `/api/auctions/2477/join` | 201 | {"depositId":"2180","deposit":100000,"balanceAfter":9900000} |
| 6 lượt giá xen kẽ giữa 2 tài khoản | — | `—` | — | kích hoạt luật "hai tài khoản đặt xen kẽ" của fraud_detection |
| Admin xem cờ đang chờ | GET | `/api/admin/flags?status=pending&limit=100&offset=0` | 200 | high 85: Chỉ hai tài khoản đặt giá xen kẽ nhau |
| Tạm dừng phiên | POST | `/api/admin/flags/1440/action` | 200 | flag=paused |
| Đặt giá khi phiên tạm dừng | POST | `/api/bids` | 409 | AUCTION_PAUSED: Phiên đang bị tạm dừng để kiểm tra |
| Chuyển sang xác minh (bỏ tạm dừng) | POST | `/api/admin/flags/1440/action` | 200 | flag=verify |
| Chấm dứt thiếu lý do | POST | `/api/admin/flags/1440/action` | 400 | VALIDATION_ERROR: Lý do không được để trống |
| Chấm dứt phiên (cancelAuction của BE1) | POST | `/api/admin/flags/1440/action` | 200 | flag=terminated, phiên=cancelled |
| Chấm dứt phiên hoàn cọc người tham gia | — | `—` | — | Bidder 1 held 100000 -> 0 |
| Xử lý cờ đã đóng | POST | `/api/admin/flags/1440/action` | 409 | INVALID_STATE: Cờ này đã được xử lý xong |

## 10. Admin: bảng điều khiển, báo cáo, khoá tài khoản; Chatbot

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bảng điều khiển | GET | `/api/admin/dashboard` | 200 | phiên live 5, tranh chấp mở 3, ký quỹ 31756000 |
| Báo cáo tuần | GET | `/api/admin/report/weekly` | 200 | 13 đơn, GMV 37050000 |
| Danh sách tài khoản (lọc theo từ khoá) | GET | `/api/admin/accounts?q=mv5b9sqvwc4` | 200 | 3 tài khoản test |
| Bidder 2 kết nối Socket.io | — | `—` | — | connected=true |
| Khoá Bidder 2 | PATCH | `/api/admin/accounts/1145` | 200 | status=suspended |
| Socket của Bidder 2 bị ngắt ngay khi khoá | — | `—` | — | account:disconnected {"code":"ACCOUNT_SUSPENDED","message":"Tài khoản đã bị khoá"}, disconnect "io server disconnect" |
| Bidder 2 bị khoá không kết nối lại được | — | `—` | — | connect_error ACCOUNT_SUSPENDED |
| Token cũ của tài khoản bị khoá | GET | `/api/me` | 403 | ACCOUNT_SUSPENDED: Tài khoản đã bị tạm khoá |
| Mở khoá Bidder 2 | PATCH | `/api/admin/accounts/1145` | 200 | {"id":"1145","fullName":"test_be2_mv5b9sqvwc4_Người mua Hai","email":"test_be2_mv5b9sqvwc4_b2@example.com","status":"active"} |
| Token dùng lại được | GET | `/api/me` | 200 | {"id":"1145","fullName":"test_be2_mv5b9sqvwc4_Người mua Hai","email":"test_be2_mv5b9sqvwc4_b2@example.com","phone":null,"avatarUrl":null,"st |
| Mở khoá thì Bidder 2 kết nối lại được | — | `—` | — | connected=true |
| Tài khoản Kho kết nối Socket.io | — | `—` | — | connected=true |
| Khoá tài khoản Kho | PATCH | `/api/admin/ops-accounts/424` | 200 | status=suspended |
| Socket của tài khoản Kho bị ngắt ngay khi khoá | — | `—` | — | account:disconnected {"code":"ACCOUNT_SUSPENDED","message":"Tài khoản đã bị khoá"} |
| Tài khoản Kho bị khoá không kết nối lại được | — | `—` | — | connect_error ACCOUNT_SUSPENDED |
| Kho bị khoá gọi API | GET | `/api/warehouse/orders` | 403 | ACCOUNT_SUSPENDED: Tài khoản đã bị tạm khoá |
| Mở khoá tài khoản Kho | PATCH | `/api/admin/ops-accounts/424` | 200 | {"id":"424","name":"test_be2_mv5b9sqvwc4_Kho","email":"test_be2_mv5b9sqvwc4_warehouse@example.com","role":"warehouse","status":"active","wee |
| Mở khoá thì tài khoản Kho kết nối lại được | — | `—` | — | connected=true |
| Khoá Bidder 2 khi ngắt socket bị lỗi vẫn thành công | PATCH | `/api/admin/accounts/1145` | 200 | status=suspended |
| Mở khoá lại Bidder 2 | PATCH | `/api/admin/accounts/1145` | 200 | {"id":"1145","fullName":"test_be2_mv5b9sqvwc4_Người mua Hai","email":"test_be2_mv5b9sqvwc4_b2@example.com","status":"active"} |
| Khoá lại tài khoản Kho | PATCH | `/api/admin/ops-accounts/424` | 200 | {"id":"424","name":"test_be2_mv5b9sqvwc4_Kho","email":"test_be2_mv5b9sqvwc4_warehouse@example.com","role":"warehouse","status":"suspended"," |
| Admin tự khoá chính mình | PATCH | `/api/admin/ops-accounts/422` | 409 | SELF_LOCKOUT: Không thể tự khoá hoặc tự bỏ quyền Admin của chính mình |
| Chatbot trả lời về đặt cọc | POST | `/api/chat/messages` | 201 | Để tham gia một phiên, bạn đặt cọc 10% giá khởi điểm (làm tròn nghìn) từ ví. Thu |
| Hỏi tiếp trong cùng phiên trò chuyện | POST | `/api/chat/messages` | 201 | Khi nhận được hàng, bạn bấm "Đã nhận hàng" để giải ngân cho người bán. Nếu không |
| Lịch sử trò chuyện | GET | `/api/chat/sessions/66/messages` | 200 | 4 tin nhắn |
| Người khác đọc lịch sử trò chuyện | GET | `/api/chat/sessions/66/messages` | 404 | NOT_FOUND: Không tìm thấy phiên trò chuyện |

## 11. Dữ liệu điều hướng (data) của thông báo

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Thông báo người bán có data | GET | `/api/notifications?limit=100` | 200 | listing_approved data={"auctionId":"2477","listingId":"2488"} |
| Thông báo người mua về đơn có data | GET | `/api/notifications?limit=100` | 200 | order data={"orderId":"818","auctionId":"2476"} |
| Thông báo tranh chấp có disputeId | GET | `/api/notifications?limit=100` | 200 | refund data={"auctionId":"2477"} |
| Thông báo không có data trả data null | GET | `/api/notifications?limit=3` | 200 | warn:null, outbid:null, refund:{"auctionId":"2477"} |
| createNotification bỏ khoá rỗng; không còn khoá nào thì lưu NULL | — | `—` | — | data { orderId: null, auctionId: "" } -> null |
| Socket notification:new có data | — | `—` | — | {"id":"6756","type":"order","title":"Thử socket có data","createdAt":"2026-10-12T13:53:07.774Z","data":{"orderId":"815","auctionId":"2473"}} |
| Socket notification:new kiểu gọi BE1: data null, các trường cũ giữ nguyên | — | `—` | — | {"id":"6757","type":"outbid","title":"Thử socket kiểu BE1","createdAt":"2026-10-12T13:53:07.836Z","data":null} |

## 12. Tải ảnh từ điện thoại (Supabase Storage)

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tải ảnh không có token | POST | `/api/uploads/images` | 401 | UNAUTHORIZED: Thiếu token xác thực |
| Tài khoản nội bộ tải ảnh bị chặn | POST | `/api/uploads/images` | 403 | FORBIDDEN: Chỉ tài khoản người dùng được tải ảnh |
| Chưa cấu hình Storage thì trả 503 | POST | `/api/uploads/images` | 503 | UPLOAD_NOT_CONFIGURED: Máy chủ chưa cấu hình nơi lưu ảnh (Supabase Storage) |
| Tải lên Supabase Storage thật: bỏ qua (chưa cấu hình Storage) | — | `—` | — | các bước dưới chạy với Storage giả lập trong tiến trình |
| File không phải ảnh (Content-Type nói là PNG) | POST | `/api/uploads/images` | 400 | INVALID_FILE_TYPE: Ảnh thứ 1 không phải JPEG, PNG hoặc WEBP |
| Ảnh GIF bị từ chối | POST | `/api/uploads/images` | 400 | INVALID_FILE_TYPE: Ảnh thứ 2 không phải JPEG, PNG hoặc WEBP |
| Ảnh quá 5 MB | POST | `/api/uploads/images` | 413 | FILE_TOO_LARGE: Mỗi ảnh tối đa 5 MB |
| Quá 8 ảnh một lần | POST | `/api/uploads/images` | 400 | TOO_MANY_FILES: Tối đa 8 ảnh mỗi lần |
| Không có file | POST | `/api/uploads/images` | 400 | VALIDATION_ERROR: Cần gửi ít nhất một ảnh trong trường files |
| Sai tên trường (file thay vì files) | POST | `/api/uploads/images` | 400 | VALIDATION_ERROR: Ảnh phải gửi trong trường files |
| purpose không hợp lệ | POST | `/api/uploads/images?purpose=banner` | 400 | VALIDATION_ERROR: purpose phải là một trong: listing, avatar |
| Seller tải 2 ảnh (PNG, JPEG) | POST | `/api/uploads/images` | 201 | …/public/test-be2-mv5b9sqvwc4-bucket/listing/1143/1791813188384-41e2e860ecbc.png, …/public/test-be2-mv5b9sqvwc4-bucket/listing/1143/1791813188384-b4a2ca4b2c00.jpg |
| GET URL public của ảnh vừa tải | — | `—` | — | 200 cho cả 2 ảnh (Storage giả lập) |
| Bidder tải ảnh đại diện (purpose=avatar) | POST | `/api/uploads/images?purpose=avatar` | 201 | …/public/test-be2-mv5b9sqvwc4-bucket/avatar/1144/1791813188502-41ef9c611d20.png |
| Gọi Storage: header và tự tạo bucket | — | `—` | — | sb_secret_: chỉ apikey; bucket chưa có -> tạo 1 lần (public, 5 MB, 3 loại ảnh) rồi tải lại |
| Key dạng JWT (service_role) | POST | `/api/uploads/images` | 201 | {"urls":["http://localhost:49536/storage/v1/object/public/test-be2-mv5b9sqvwc4-bucket/listing/1143/1791813188556-14a1a7a2231e.png"]} |
| Key JWT gửi cả apikey và Authorization: Bearer | — | `—` | — | đúng |
| Storage trả lỗi thì 502 UPLOAD_FAILED | POST | `/api/uploads/images` | 502 | UPLOAD_FAILED: Không lưu được ảnh lên Storage: 500 Lỗi giả lập |
| Xoá các ảnh test vừa tải lên Storage | — | `—` | — | Storage giả lập: đã xoá |

## 13. Hồ sơ, đổi mật khẩu, đọc hết thông báo, xoá ảnh tin đăng

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| GET /me của Seller có storeName | GET | `/api/me` | 200 | storeName=test_be2_mv5b9sqvwc4_Shop |
| GET /me của Bidder không có storeName | GET | `/api/me` | 200 | storeName có: false |
| Seller sửa họ tên, số điện thoại, tên gian hàng | PATCH | `/api/me` | 200 | fullName=test_be2_mv5b9sqvwc4_Người bán (đã sửa), phone=0903 222 333, storeName=test_be2_mv5b9sqvwc4_Shop mới |
| Bidder đặt ảnh đại diện bằng URL vừa tải | PATCH | `/api/me` | 200 | avatarUrl đã đặt |
| Bidder xoá ảnh đại diện (null) | PATCH | `/api/me` | 200 | {"id":"1144","fullName":"test_be2_mv5b9sqvwc4_Người mua Một","email":"test_be2_mv5b9sqvwc4_b1@example.com","phone":null,"avatarUrl":null,"st |
| Số điện thoại sai | PATCH | `/api/me` | 400 | VALIDATION_ERROR: Số điện thoại không hợp lệ |
| avatarUrl không phải URL | PATCH | `/api/me` | 400 | VALIDATION_ERROR: Ảnh đại diện không hợp lệ |
| Bidder gửi shopName | PATCH | `/api/me` | 400 | VALIDATION_ERROR: Chỉ Seller có tên gian hàng |
| Không có trường nào | PATCH | `/api/me` | 400 | VALIDATION_ERROR: Không có trường nào để cập nhật |
| Tài khoản nội bộ sửa hồ sơ | PATCH | `/api/me` | 403 | FORBIDDEN: Tài khoản nội bộ không sửa hồ sơ qua API này |
| Đổi mật khẩu: sai mật khẩu hiện tại | POST | `/api/me/password` | 400 | WRONG_PASSWORD: Mật khẩu hiện tại không đúng |
| Đổi mật khẩu: mật khẩu mới quá ngắn | POST | `/api/me/password` | 400 | VALIDATION_ERROR: Mật khẩu tối thiểu 6 ký tự |
| Seller đổi mật khẩu | POST | `/api/me/password` | 200 | {"changed":true} |
| Đăng nhập bằng mật khẩu cũ | POST | `/api/auth/login` | 401 | INVALID_CREDENTIALS: Email hoặc mật khẩu không đúng |
| Đăng nhập bằng mật khẩu mới | POST | `/api/auth/login` | 200 | role=seller, token=(che) |
| Tài khoản nội bộ đổi mật khẩu | POST | `/api/me/password` | 200 | {"changed":true} |
| Thẩm định đăng nhập bằng mật khẩu mới | POST | `/api/auth/ops/login` | 200 | role=appraiser, token=(che) |
| Đánh dấu đã đọc tất cả | POST | `/api/notifications/read-all` | 200 | updated=30 |
| Mọi thông báo đã đọc | GET | `/api/notifications?limit=100` | 200 | 0 chưa đọc |
| Gọi lại khi không còn thông báo chưa đọc | POST | `/api/notifications/read-all` | 200 | updated=0 |
| Tài khoản nội bộ gọi read-all | POST | `/api/notifications/read-all` | 403 | FORBIDDEN: Tài khoản nội bộ không có thông báo |
| Tạo tin nháp để thử xoá ảnh | POST | `/api/listings` | 201 | {"id":"2489","title":"test_be2_mv5b9sqvwc4_Đèn bàn (xoá ảnh)","category":"antique","description":null,"condition":null,"startingPrice":10000 |
| Thêm 3 ảnh | POST | `/api/listings/2489/photos` | 201 | photos[].id: "707", "708", "709" |
| Xoá ảnh thứ hai | DELETE | `/api/listings/2489/photos/708` | 200 | còn 707, 709 |
| Xoá lại ảnh đã xoá | DELETE | `/api/listings/2489/photos/708` | 404 | NOT_FOUND: Không tìm thấy ảnh |
| Xoá ảnh của tin khác qua đường dẫn tin này | DELETE | `/api/listings/2489/photos/700` | 404 | NOT_FOUND: Không tìm thấy ảnh |
| Bidder xoá ảnh tin đăng | DELETE | `/api/listings/2489/photos/707` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| photoId không hợp lệ | DELETE | `/api/listings/2489/photos/abc` | 400 | VALIDATION_ERROR: photoId không hợp lệ |
| Gửi thẩm định | POST | `/api/listings/2489/submit` | 200 | {"id":"2489","title":"test_be2_mv5b9sqvwc4_Đèn bàn (xoá ảnh)","category":"antique","description":null,"condition":null,"startingPrice":10000 |
| Xoá ảnh khi tin đang chờ thẩm định | DELETE | `/api/listings/2489/photos/707` | 409 | INVALID_STATE: Không thể xoá ảnh khi tin đăng đang ở trạng thái "chờ thẩm định" |

## 14. Kiểm tra tính nhất quán của ví

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Số dư ví khớp balance_after của giao dịch cuối | — | `—` | — | cả hai Bidder test |

## 15. Kết nối database bị rớt không làm sập tiến trình

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Mô phỏng pool.emit('error', ECONNRESET) | — | `—` | — | ghi log: "[db] kết nối rảnh bị lỗi, đã loại khỏi pool: ECONNRESET read ECONNRESET"; tiến trình còn sống, truy vấn sau đó vẫn chạy |
| API vẫn trả lời sau lỗi kết nối | GET | `/api/me` | 200 | role=bidder |
