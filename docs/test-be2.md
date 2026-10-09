# Kết quả kiểm thử BE2

Chạy lúc 2026-10-09T15:50:57.755Z bằng `node scripts/test_be2.js --report docs/test-be2.md`.
Gọi API thật qua HTTP (server chạy trong tiến trình, cổng ngẫu nhiên) trên database thật dùng chung.
Tài khoản test có email `test_be2_<thời điểm>_...@example.com` và được dọn sạch sau khi chạy.
Server test không chạy scheduler nên hai mốc thời gian được ép: đóng phiên (đặt `ends_at` về quá khứ rồi gọi `closeAuction` của BE1) và tự giải ngân (đặt `payout_deadline` về quá khứ rồi gọi `releaseOverduePayouts`). Token trong phản hồi được che.

**Kết quả: ĐẠT 176 bước**

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
| Admin tạo tài khoản Thẩm định | POST | `/api/admin/ops-accounts` | 201 | {"id":"72","name":"Thẩm định test","email":"test_be2_1791560995702_appraiser@example.com","role":"appraiser","status":"active","weeklyLoad": |
| Admin tạo tài khoản Kho | POST | `/api/admin/ops-accounts` | 201 | {"id":"73","name":"Kho test","email":"test_be2_1791560995702_warehouse@example.com","role":"warehouse","status":"active","weeklyLoad":0,"has |
| Tạo ops trùng email | POST | `/api/admin/ops-accounts` | 409 | EMAIL_TAKEN: Email này đã được dùng cho tài khoản nội bộ khác |
| Thẩm định đăng nhập | POST | `/api/auth/ops/login` | 200 | role=appraiser, token=(che) |
| Kho đăng nhập | POST | `/api/auth/ops/login` | 200 | role=warehouse, token=(che) |
| Seller gọi API Admin bị chặn | GET | `/api/admin/dashboard` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |

## 2. Seller đăng tin, Thẩm định yêu cầu bổ sung rồi duyệt

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Danh mục | GET | `/api/categories` | 200 | shoes, elec, antique |
| AI gợi ý giá | POST | `/api/ai/suggest-price` | 200 | basis=history, gợi ý 2200000 |
| Tạo tin (nháp) | POST | `/api/listings` | 201 | id=89, status=draft |
| Gửi thẩm định khi chưa có ảnh | POST | `/api/listings/89/submit` | 400 | PHOTOS_REQUIRED: Cần ít nhất một ảnh trước khi gửi thẩm định |
| Thêm ảnh (URL) | POST | `/api/listings/89/photos` | 201 | 2 ảnh |
| Gửi thẩm định | POST | `/api/listings/89/submit` | 200 | status=pending_appraisal |
| Sửa khi đang chờ thẩm định | PATCH | `/api/listings/89` | 409 | INVALID_STATE: Không thể sửa khi tin đăng đang ở trạng thái "chờ thẩm định" |
| Hàng chờ thẩm định có tin mới | GET | `/api/appraisals/queue` | 200 | có tin test: true |
| Yêu cầu bổ sung | POST | `/api/appraisals/89/decision` | 201 | listing=needs_info |
| Duyệt khi tin đang chờ bổ sung | POST | `/api/appraisals/89/decision` | 409 | INVALID_STATE: Không thể thẩm định khi tin đăng đang ở trạng thái "cần bổ sung" |
| Seller sửa mô tả (needs_info) | PATCH | `/api/listings/89` | 200 | {"id":"89","title":"Máy nghe nhạc test BE2","category":"elec","description":"Đã bổ sung ảnh số seri","condition":"Như mới","startingPrice":1 |
| Seller thêm ảnh số seri | POST | `/api/listings/89/photos` | 201 | {"id":"89","title":"Máy nghe nhạc test BE2","category":"elec","description":"Đã bổ sung ảnh số seri","condition":"Như mới","startingPrice":1 |
| Seller nộp lại | POST | `/api/listings/89/resubmit` | 200 | status=pending_appraisal |
| Thẩm định duyệt -> sinh phiên | POST | `/api/appraisals/89/decision` | 201 | listing=live, auctionId=82 |
| Lịch sử thẩm định (2 dòng, không sửa dòng cũ) | GET | `/api/appraisals/89` | 200 | more_info -> approve |
| Seller nhận thông báo duyệt | GET | `/api/notifications` | 200 | listing_approved, listing_needs_info |

## 3. Bidder nạp ví, đặt cọc, trả giá; phiên kết thúc

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bidder 1 nạp ví | POST | `/api/wallet/topup` | 201 | balance=10000000 |
| Bidder 2 nạp ví | POST | `/api/wallet/topup` | 201 | balance=10000000 |
| Đặt giá khi chưa cọc | POST | `/api/bids` | 403 | DEPOSIT_REQUIRED: Cần đặt cọc tham gia trước khi đặt giá |
| Bidder 1 đặt cọc | POST | `/api/auctions/82/join` | 201 | cọc 100000 |
| Bidder 2 đặt cọc | POST | `/api/auctions/82/join` | 201 | cọc 100000 |
| Bidder 1 trả giá | POST | `/api/bids` | 201 | {"bidId":"213","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:50:02.599Z","extended":false} |
| Bidder 2 trả giá cao hơn | POST | `/api/bids` | 201 | {"bidId":"214","currentPrice":1100000,"bidCount":2,"endsAt":"2026-10-10T15:50:02.599Z","extended":false} |
| Bidder 1 trả giá thấp hơn mức tối thiểu | POST | `/api/bids` | 400 | BID_TOO_LOW: Giá tối thiểu là 1.150.000đ |
| Bidder 1 trả giá | POST | `/api/bids` | 201 | {"bidId":"215","currentPrice":1150000,"bidCount":3,"endsAt":"2026-10-10T15:50:02.599Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) chọn người thắng | — | `—` | — | orderId=48 |
| Người thua được hoàn cọc về ví | — | `—` | — | Bidder 2: held 100000 -> 0, balance 9900000 -> 10000000 |

## 4. Địa chỉ giao hàng của người mua

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bidder 1 chưa có địa chỉ | GET | `/api/addresses` | 200 | 0 địa chỉ |
| Seller không dùng API địa chỉ | GET | `/api/addresses` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| Thêm địa chỉ với số điện thoại sai | POST | `/api/addresses` | 400 | VALIDATION_ERROR: Số điện thoại không hợp lệ |
| Thêm địa chỉ thiếu địa chỉ | POST | `/api/addresses` | 400 | VALIDATION_ERROR: Địa chỉ không được để trống |
| Thêm địa chỉ đầu tiên (tự thành mặc định) | POST | `/api/addresses` | 201 | id=14, isDefault=true |
| Thêm địa chỉ thứ hai | POST | `/api/addresses` | 201 | id=15, isDefault=false |
| Đặt địa chỉ thứ hai làm mặc định | POST | `/api/addresses/15/default` | 200 | isDefault=true |
| Danh sách sau khi đổi mặc định | GET | `/api/addresses` | 200 | 15(mặc định), 14 |
| Sửa địa chỉ (chưa đơn nào dùng, sửa tại chỗ) | PATCH | `/api/addresses/14` | 200 | id=14, 45A Võ Văn Tần |
| Bidder 2 sửa địa chỉ của Bidder 1 | PATCH | `/api/addresses/14` | 404 | NOT_FOUND: Không tìm thấy địa chỉ |
| Bidder 2 xoá địa chỉ của Bidder 1 | DELETE | `/api/addresses/14` | 404 | NOT_FOUND: Không tìm thấy địa chỉ |
| Bidder 2 đặt mặc định địa chỉ của Bidder 1 | POST | `/api/addresses/14/default` | 404 | NOT_FOUND: Không tìm thấy địa chỉ |

## 5. Thanh toán, gửi kho, kho xử lý, xác nhận, giải ngân

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Đơn thắng của Bidder 1 | GET | `/api/orders/mine` | 200 | totalDue=1248000, amountToPay=1148000 |
| Gửi kho khi chưa thanh toán | POST | `/api/orders/48/ship-to-warehouse` | 409 | INVALID_STATE: Đơn chưa được thanh toán, chưa thể gửi hàng |
| Bidder 1 thanh toán bằng ví | POST | `/api/orders/48/pay` | 200 | paymentStatus=paid |
| Seller xem đơn đã bán | GET | `/api/orders/selling?stage=awaiting_seller_shipment` | 200 | 1 đơn chờ gửi kho |
| Bidder không gọi được API của Seller | GET | `/api/orders/selling` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| Kho nhận hàng khi Seller chưa gửi | POST | `/api/warehouse/orders/48/receive` | 409 | INVALID_STATE: Người bán chưa báo gửi hàng về kho |
| Seller gửi hàng về kho | POST | `/api/orders/48/ship-to-warehouse` | 200 | stage=in_transit_to_warehouse, mã BV-091026-0048 |
| Seller gửi lần hai | POST | `/api/orders/48/ship-to-warehouse` | 409 | ALREADY_SHIPPED: Đơn này đã được báo gửi về kho |
| Kho xem đơn đang về | GET | `/api/warehouse/orders?stage=in_transit_to_warehouse` | 200 | có đơn test: true |
| Đóng gói trước khi nhận | POST | `/api/warehouse/orders/48/pack` | 409 | INVALID_STATE: Chỉ đóng gói được đơn đã kiểm đạt |
| Kho nhận hàng | POST | `/api/warehouse/orders/48/receive` | 200 | stage=inspecting |
| Kiểm hàng: khớp mô tả | POST | `/api/warehouse/orders/48/inspect` | 200 | stage=inspected |
| Gửi đi trước khi đóng gói | POST | `/api/warehouse/orders/48/ship` | 409 | INVALID_STATE: Chỉ gửi đi được đơn đã đóng gói |
| Đóng gói | POST | `/api/warehouse/orders/48/pack` | 200 | stage=packed |
| Gửi đi khi đơn chưa có địa chỉ | POST | `/api/warehouse/orders/48/ship` | 409 | ORDER_NO_ADDRESS: Người mua chưa chọn địa chỉ giao hàng cho đơn này, chưa thể gửi đi |
| Bidder 2 gắn địa chỉ vào đơn của Bidder 1 | POST | `/api/orders/48/shipping-address` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Seller gắn địa chỉ vào đơn | POST | `/api/orders/48/shipping-address` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| Bidder 1 chọn địa chỉ giao hàng | POST | `/api/orders/48/shipping-address` | 200 | 12 Phố Huế, Hà Nội |
| Bidder 1 đổi sang địa chỉ khác (còn trước khi gửi) | POST | `/api/orders/48/shipping-address` | 200 | 45A Võ Văn Tần, TP.HCM |
| Kho thấy địa chỉ giao hàng | GET | `/api/warehouse/orders?stage=packed` | 200 | Người mua Một · 0903 112 233 · 45A Võ Văn Tần, TP.HCM |
| Gửi cho đơn vị vận chuyển | POST | `/api/warehouse/orders/48/ship` | 200 | stage=shipped, mã GHNTEST0001 |
| Đổi địa chỉ khi đơn đã gửi đi | POST | `/api/orders/48/shipping-address` | 409 | ALREADY_SHIPPED: Đơn đã được gửi đi, không thể đổi địa chỉ giao hàng |
| Bidder xác nhận khi chưa giao | POST | `/api/orders/48/confirm-delivery` | 409 | NOT_DELIVERED: Đơn chưa được giao, chưa thể xác nhận |
| Giao thành công | POST | `/api/warehouse/orders/48/deliver` | 200 | stage=delivered, payoutDeadline=2026-10-12T15:50:17.496Z |
| Bidder 2 xác nhận đơn không phải của mình | POST | `/api/orders/48/confirm-delivery` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Bidder 1 xác nhận đã nhận hàng | POST | `/api/orders/48/confirm-delivery` | 200 | stage=completed, payoutStatus=released |
| Xác nhận lần hai | POST | `/api/orders/48/confirm-delivery` | 409 | ALREADY_CONFIRMED: Bạn đã xác nhận nhận hàng cho đơn này |
| Theo dõi đơn (người mua) | GET | `/api/orders/48/tracking` | 200 | packing -> shipped -> delivered; giao tới 45A Võ Văn Tần |
| Theo dõi đơn (người bán, không thấy địa chỉ) | GET | `/api/orders/48/tracking` | 200 | có shippingAddress: false |
| Sửa địa chỉ đơn đã gửi đang dùng (tạo bản mới) | PATCH | `/api/addresses/14` | 200 | id cũ=14, id mới=16 |
| Đơn đã gửi vẫn giữ địa chỉ cũ | GET | `/api/orders/48/tracking` | 200 | 14: 45A Võ Văn Tần |
| Xoá địa chỉ (xoá mềm) | DELETE | `/api/addresses/16` | 200 | deleted=true |
| Danh sách sau khi xoá | GET | `/api/addresses` | 200 | 1 địa chỉ, mặc định 15 |
| Đơn đã gửi vẫn đọc được địa chỉ sau khi xoá | GET | `/api/orders/48/tracking` | 200 | 45A Võ Văn Tần |
| Seller nhận thông báo giải ngân | GET | `/api/notifications` | 200 | payout, sold, listing_approved, listing_needs_info |

## 6. Tranh chấp do Kho mở (hàng không khớp) -> Admin hoàn tiền

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "Bình gốm test BE2 (tranh chấp)" | POST | `/api/listings` | 201 | id=90 |
| Thêm ảnh | POST | `/api/listings/90/photos` | 201 | {"id":"90","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugg |
| Gửi thẩm định | POST | `/api/listings/90/submit` | 200 | {"id":"90","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugg |
| Duyệt | POST | `/api/appraisals/90/decision` | 201 | auctionId=83 |
| Đặt cọc | POST | `/api/auctions/83/join` | 201 | {"depositId":"134","deposit":100000,"balanceAfter":9900000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"216","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:50:22.048Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=49 |
| Thanh toán bằng ví | POST | `/api/orders/49/pay` | 200 | {"orderId":"49","paymentStatus":"paid","totalDue":1143000,"balanceAfter":8857000} |
| Seller gửi hàng về kho | POST | `/api/orders/49/ship-to-warehouse` | 200 | {"id":"49","auctionId":"83","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","payme |
| Kho nhận hàng | POST | `/api/warehouse/orders/49/receive` | 200 | {"id":"49","auctionId":"83","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","payme |
| Kiểm hàng: không khớp thiếu ghi chú | POST | `/api/warehouse/orders/49/inspect` | 400 | VALIDATION_ERROR: Ghi chú kiểm hàng không được để trống |
| Kiểm hàng: không khớp -> tự mở tranh chấp | POST | `/api/warehouse/orders/49/inspect` | 200 | stage=inspection_failed, payoutStatus=disputed |
| Không đóng gói được đơn đang tranh chấp | POST | `/api/warehouse/orders/49/pack` | 409 | INVALID_STATE: Chỉ đóng gói được đơn đã kiểm đạt |
| Bidder mở thêm tranh chấp khi đã có | POST | `/api/disputes` | 409 | DISPUTE_OPEN: Đơn này đang có tranh chấp chờ xử lý |
| Admin xem tranh chấp đang mở | GET | `/api/admin/disputes?status=open` | 200 | 4 tranh chấp mở |
| Admin phán quyết hoàn tiền | POST | `/api/admin/disputes/17/resolve` | 200 | status=resolved, resolution=refund, ký quỹ 1143000 |
| Ví người mua được hoàn qua wallet_service.refund (BE1) | — | `—` | — | balance 8857000 -> 10000000; wallet_transactions: refund 1143000, balance_after 10000000 |
| Phán quyết lần hai | POST | `/api/admin/disputes/17/resolve` | 409 | ALREADY_RESOLVED: Tranh chấp này đã được xử lý |

## 7. Tranh chấp do Bidder mở sau khi giao -> Admin giữ nguyên, giải ngân

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "Đồng hồ test BE2 (giữ nguyên)" | POST | `/api/listings` | 201 | id=91 |
| Thêm ảnh | POST | `/api/listings/91/photos` | 201 | {"id":"91","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Gửi thẩm định | POST | `/api/listings/91/submit` | 200 | {"id":"91","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Duyệt | POST | `/api/appraisals/91/decision` | 201 | auctionId=84 |
| Đặt cọc | POST | `/api/auctions/84/join` | 201 | {"depositId":"135","deposit":100000,"balanceAfter":8652000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"217","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:50:28.907Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=50 |
| Thanh toán bằng ví | POST | `/api/orders/50/pay` | 200 | {"orderId":"50","paymentStatus":"paid","totalDue":1143000,"balanceAfter":7609000} |
| Seller gửi hàng về kho | POST | `/api/orders/50/ship-to-warehouse` | 200 | {"id":"50","auctionId":"84","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kho nhận hàng | POST | `/api/warehouse/orders/50/receive` | 200 | {"id":"50","auctionId":"84","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kiểm hàng: khớp | POST | `/api/warehouse/orders/50/inspect` | 200 | {"id":"50","auctionId":"84","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Đóng gói | POST | `/api/warehouse/orders/50/pack` | 200 | {"id":"50","auctionId":"84","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Bidder lấy địa chỉ mặc định | GET | `/api/addresses` | 200 | 1 địa chỉ |
| Bidder chọn địa chỉ giao hàng | POST | `/api/orders/50/shipping-address` | 200 | {"id":"50","auctionId":"84","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Gửi đi | POST | `/api/warehouse/orders/50/ship` | 200 | {"id":"50","auctionId":"84","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Giao thành công | POST | `/api/warehouse/orders/50/deliver` | 200 | {"id":"50","auctionId":"84","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Bidder 2 mở tranh chấp đơn của người khác | POST | `/api/disputes` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Bidder mở tranh chấp | POST | `/api/disputes` | 201 | source=bidder, payoutStatus=disputed |
| Xác nhận nhận hàng khi đang tranh chấp | POST | `/api/orders/50/confirm-delivery` | 409 | DISPUTE_OPEN: Đơn đang có tranh chấp, chờ Admin xử lý |
| Admin phán quyết giữ nguyên | POST | `/api/admin/disputes/18/resolve` | 200 | resolution=keep, payoutStatus=released |

## 8. Tự giải ngân sau 72 giờ

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "Radio test BE2 (tự giải ngân)" | POST | `/api/listings` | 201 | id=92 |
| Thêm ảnh | POST | `/api/listings/92/photos` | 201 | {"id":"92","title":"Radio test BE2 (tự giải ngân)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Gửi thẩm định | POST | `/api/listings/92/submit` | 200 | {"id":"92","title":"Radio test BE2 (tự giải ngân)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Duyệt | POST | `/api/appraisals/92/decision` | 201 | auctionId=85 |
| Đặt cọc | POST | `/api/auctions/85/join` | 201 | {"depositId":"136","deposit":100000,"balanceAfter":7509000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"218","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:50:37.609Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=51 |
| Thanh toán bằng ví | POST | `/api/orders/51/pay` | 200 | {"orderId":"51","paymentStatus":"paid","totalDue":1143000,"balanceAfter":6466000} |
| Seller gửi hàng về kho | POST | `/api/orders/51/ship-to-warehouse` | 200 | {"id":"51","auctionId":"85","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kho nhận hàng | POST | `/api/warehouse/orders/51/receive` | 200 | {"id":"51","auctionId":"85","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kiểm hàng: khớp | POST | `/api/warehouse/orders/51/inspect` | 200 | {"id":"51","auctionId":"85","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Đóng gói | POST | `/api/warehouse/orders/51/pack` | 200 | {"id":"51","auctionId":"85","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Bidder lấy địa chỉ mặc định | GET | `/api/addresses` | 200 | 1 địa chỉ |
| Bidder chọn địa chỉ giao hàng | POST | `/api/orders/51/shipping-address` | 200 | {"id":"51","auctionId":"85","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Gửi đi | POST | `/api/warehouse/orders/51/ship` | 200 | {"id":"51","auctionId":"85","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Giao thành công | POST | `/api/warehouse/orders/51/deliver` | 200 | {"id":"51","auctionId":"85","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Chưa tới hạn thì job không giải ngân | — | `—` | — | đơn vẫn payout_status = pending |
| Đơn đã tự giải ngân | GET | `/api/orders/51/tracking` | 200 | stage=completed, payoutStatus=released, deliveredConfirmedAt=null |

## 9. Phiên bị gắn cờ (fraud_detection của BE1) -> Admin xử lý

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin | POST | `/api/listings` | 201 | {"id":"93","title":"Máy ảnh test BE2 (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000,"aiSuggestedPri |
| Thêm ảnh | POST | `/api/listings/93/photos` | 201 | {"id":"93","title":"Máy ảnh test BE2 (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000,"aiSuggestedPri |
| Gửi thẩm định | POST | `/api/listings/93/submit` | 200 | {"id":"93","title":"Máy ảnh test BE2 (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000,"aiSuggestedPri |
| Duyệt | POST | `/api/appraisals/93/decision` | 201 | {"appraisalId":"65","decidedAt":"2026-10-09T15:50:47.374Z","listingId":"93","decision":"approve","listingStatus":"live","auctionId":"86"} |
| Bidder 1 đặt cọc | POST | `/api/auctions/86/join` | 201 | {"depositId":"137","deposit":100000,"balanceAfter":6366000} |
| Bidder 2 đặt cọc | POST | `/api/auctions/86/join` | 201 | {"depositId":"138","deposit":100000,"balanceAfter":9900000} |
| 6 lượt giá xen kẽ giữa 2 tài khoản | — | `—` | — | kích hoạt luật "hai tài khoản đặt xen kẽ" của fraud_detection |
| Admin xem cờ đang chờ | GET | `/api/admin/flags?status=pending` | 200 | high 85: Chỉ hai tài khoản đặt giá xen kẽ nhau |
| Tạm dừng phiên | POST | `/api/admin/flags/26/action` | 200 | flag=paused |
| Đặt giá khi phiên tạm dừng | POST | `/api/bids` | 409 | AUCTION_PAUSED: Phiên đang bị tạm dừng để kiểm tra |
| Chuyển sang xác minh (bỏ tạm dừng) | POST | `/api/admin/flags/26/action` | 200 | flag=verify |
| Chấm dứt thiếu lý do | POST | `/api/admin/flags/26/action` | 400 | VALIDATION_ERROR: Lý do không được để trống |
| Chấm dứt phiên (cancelAuction của BE1) | POST | `/api/admin/flags/26/action` | 200 | flag=terminated, phiên=cancelled |
| Chấm dứt phiên hoàn cọc người tham gia | — | `—` | — | Bidder 1 held 100000 -> 0 |
| Xử lý cờ đã đóng | POST | `/api/admin/flags/26/action` | 409 | INVALID_STATE: Cờ này đã được xử lý xong |

## 10. Admin: bảng điều khiển, báo cáo, khoá tài khoản; Chatbot

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bảng điều khiển | GET | `/api/admin/dashboard` | 200 | phiên live 6, tranh chấp mở 3, ký quỹ 33739000 |
| Báo cáo tuần | GET | `/api/admin/report/weekly` | 200 | 12 đơn, GMV 27150000 |
| Danh sách tài khoản (lọc theo từ khoá) | GET | `/api/admin/accounts?q=test_be2_1791560995702` | 200 | 3 tài khoản test |
| Khoá Bidder 2 | PATCH | `/api/admin/accounts/69` | 200 | status=suspended |
| Token cũ của tài khoản bị khoá | GET | `/api/me` | 403 | ACCOUNT_SUSPENDED: Tài khoản đã bị tạm khoá |
| Mở khoá Bidder 2 | PATCH | `/api/admin/accounts/69` | 200 | {"id":"69","fullName":"Người mua Hai","email":"test_be2_1791560995702_b2@example.com","status":"active"} |
| Token dùng lại được | GET | `/api/me` | 200 | {"id":"69","fullName":"Người mua Hai","email":"test_be2_1791560995702_b2@example.com","phone":null,"avatarUrl":null,"status":"active","role" |
| Khoá tài khoản Kho | PATCH | `/api/admin/ops-accounts/73` | 200 | status=suspended |
| Kho bị khoá gọi API | GET | `/api/warehouse/orders` | 403 | ACCOUNT_SUSPENDED: Tài khoản đã bị tạm khoá |
| Admin tự khoá chính mình | PATCH | `/api/admin/ops-accounts/71` | 409 | SELF_LOCKOUT: Không thể tự khoá hoặc tự bỏ quyền Admin của chính mình |
| Chatbot trả lời về đặt cọc | POST | `/api/chat/messages` | 201 | Để tham gia một phiên, bạn đặt cọc 10% giá khởi điểm (làm tròn nghìn) từ ví. Thu |
| Hỏi tiếp trong cùng phiên trò chuyện | POST | `/api/chat/messages` | 201 | Khi nhận được hàng, bạn bấm "Đã nhận hàng" để giải ngân cho người bán. Nếu không |
| Lịch sử trò chuyện | GET | `/api/chat/sessions/7/messages` | 200 | 4 tin nhắn |
| Người khác đọc lịch sử trò chuyện | GET | `/api/chat/sessions/7/messages` | 404 | NOT_FOUND: Không tìm thấy phiên trò chuyện |

## 11. Kiểm tra tính nhất quán của ví

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Số dư ví khớp balance_after của giao dịch cuối | — | `—` | — | cả hai Bidder test |
