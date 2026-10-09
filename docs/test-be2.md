# Kết quả kiểm thử BE2

Chạy lúc 2026-10-09T15:28:58.621Z bằng `node scripts/test_be2.js --report docs/test-be2.md`.
Gọi API thật qua HTTP (server chạy trong tiến trình, cổng ngẫu nhiên) trên database thật dùng chung.
Tài khoản test có email `test_be2_<thời điểm>_...@example.com` và được dọn sạch sau khi chạy.
Server test không chạy scheduler nên hai mốc thời gian được ép: đóng phiên (đặt `ends_at` về quá khứ rồi gọi `closeAuction` của BE1) và tự giải ngân (đặt `payout_deadline` về quá khứ rồi gọi `releaseOverduePayouts`). Token trong phản hồi được che.

**Kết quả: ĐẠT 147 bước**

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
| Admin tạo tài khoản Thẩm định | POST | `/api/admin/ops-accounts` | 201 | {"id":"34","name":"Thẩm định test","email":"test_be2_1791559687274_appraiser@example.com","role":"appraiser","status":"active","weeklyLoad": |
| Admin tạo tài khoản Kho | POST | `/api/admin/ops-accounts` | 201 | {"id":"35","name":"Kho test","email":"test_be2_1791559687274_warehouse@example.com","role":"warehouse","status":"active","weeklyLoad":0,"has |
| Tạo ops trùng email | POST | `/api/admin/ops-accounts` | 409 | EMAIL_TAKEN: Email này đã được dùng cho tài khoản nội bộ khác |
| Thẩm định đăng nhập | POST | `/api/auth/ops/login` | 200 | role=appraiser, token=(che) |
| Kho đăng nhập | POST | `/api/auth/ops/login` | 200 | role=warehouse, token=(che) |
| Seller gọi API Admin bị chặn | GET | `/api/admin/dashboard` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |

## 2. Seller đăng tin, Thẩm định yêu cầu bổ sung rồi duyệt

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Danh mục | GET | `/api/categories` | 200 | shoes, elec, antique |
| AI gợi ý giá | POST | `/api/ai/suggest-price` | 200 | basis=history, gợi ý 2200000 |
| Tạo tin (nháp) | POST | `/api/listings` | 201 | id=52, status=draft |
| Gửi thẩm định khi chưa có ảnh | POST | `/api/listings/52/submit` | 400 | PHOTOS_REQUIRED: Cần ít nhất một ảnh trước khi gửi thẩm định |
| Thêm ảnh (URL) | POST | `/api/listings/52/photos` | 201 | 2 ảnh |
| Gửi thẩm định | POST | `/api/listings/52/submit` | 200 | status=pending_appraisal |
| Sửa khi đang chờ thẩm định | PATCH | `/api/listings/52` | 409 | INVALID_STATE: Không thể sửa khi tin đăng đang ở trạng thái "chờ thẩm định" |
| Hàng chờ thẩm định có tin mới | GET | `/api/appraisals/queue` | 200 | có tin test: true |
| Yêu cầu bổ sung | POST | `/api/appraisals/52/decision` | 201 | listing=needs_info |
| Duyệt khi tin đang chờ bổ sung | POST | `/api/appraisals/52/decision` | 409 | INVALID_STATE: Không thể thẩm định khi tin đăng đang ở trạng thái "cần bổ sung" |
| Seller sửa mô tả (needs_info) | PATCH | `/api/listings/52` | 200 | {"id":"52","title":"Máy nghe nhạc test BE2","category":"elec","description":"Đã bổ sung ảnh số seri","condition":"Như mới","startingPrice":1 |
| Seller thêm ảnh số seri | POST | `/api/listings/52/photos` | 201 | {"id":"52","title":"Máy nghe nhạc test BE2","category":"elec","description":"Đã bổ sung ảnh số seri","condition":"Như mới","startingPrice":1 |
| Seller nộp lại | POST | `/api/listings/52/resubmit` | 200 | status=pending_appraisal |
| Thẩm định duyệt -> sinh phiên | POST | `/api/appraisals/52/decision` | 201 | listing=live, auctionId=45 |
| Lịch sử thẩm định (2 dòng, không sửa dòng cũ) | GET | `/api/appraisals/52` | 200 | more_info -> approve |
| Seller nhận thông báo duyệt | GET | `/api/notifications` | 200 | listing_approved, listing_needs_info |

## 3. Bidder nạp ví, đặt cọc, trả giá; phiên kết thúc

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bidder 1 nạp ví | POST | `/api/wallet/topup` | 201 | balance=10000000 |
| Bidder 2 nạp ví | POST | `/api/wallet/topup` | 201 | balance=10000000 |
| Đặt giá khi chưa cọc | POST | `/api/bids` | 403 | DEPOSIT_REQUIRED: Cần đặt cọc tham gia trước khi đặt giá |
| Bidder 1 đặt cọc | POST | `/api/auctions/45/join` | 201 | cọc 100000 |
| Bidder 2 đặt cọc | POST | `/api/auctions/45/join` | 201 | cọc 100000 |
| Bidder 1 trả giá | POST | `/api/bids` | 201 | {"bidId":"131","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:28:14.188Z","extended":false} |
| Bidder 2 trả giá cao hơn | POST | `/api/bids` | 201 | {"bidId":"132","currentPrice":1100000,"bidCount":2,"endsAt":"2026-10-10T15:28:14.188Z","extended":false} |
| Bidder 1 trả giá thấp hơn mức tối thiểu | POST | `/api/bids` | 400 | BID_TOO_LOW: Giá tối thiểu là 1.150.000đ |
| Bidder 1 trả giá | POST | `/api/bids` | 201 | {"bidId":"133","currentPrice":1150000,"bidCount":3,"endsAt":"2026-10-10T15:28:14.188Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) chọn người thắng | — | `—` | — | orderId=24 |
| Người thua được hoàn cọc về ví | — | `—` | — | Bidder 2: held 100000 -> 0, balance 9900000 -> 10000000 |

## 4. Thanh toán, gửi kho, kho xử lý, xác nhận, giải ngân

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Đơn thắng của Bidder 1 | GET | `/api/orders/mine` | 200 | totalDue=1248000, amountToPay=1148000 |
| Gửi kho khi chưa thanh toán | POST | `/api/orders/24/ship-to-warehouse` | 409 | INVALID_STATE: Đơn chưa được thanh toán, chưa thể gửi hàng |
| Bidder 1 thanh toán bằng ví | POST | `/api/orders/24/pay` | 200 | paymentStatus=paid |
| Seller xem đơn đã bán | GET | `/api/orders/selling?stage=awaiting_seller_shipment` | 200 | 1 đơn chờ gửi kho |
| Bidder không gọi được API của Seller | GET | `/api/orders/selling` | 403 | FORBIDDEN: Bạn không có quyền thực hiện thao tác này |
| Kho nhận hàng khi Seller chưa gửi | POST | `/api/warehouse/orders/24/receive` | 409 | INVALID_STATE: Người bán chưa báo gửi hàng về kho |
| Seller gửi hàng về kho | POST | `/api/orders/24/ship-to-warehouse` | 200 | stage=in_transit_to_warehouse, mã BV-091026-0024 |
| Seller gửi lần hai | POST | `/api/orders/24/ship-to-warehouse` | 409 | ALREADY_SHIPPED: Đơn này đã được báo gửi về kho |
| Kho xem đơn đang về | GET | `/api/warehouse/orders?stage=in_transit_to_warehouse` | 200 | có đơn test: true |
| Đóng gói trước khi nhận | POST | `/api/warehouse/orders/24/pack` | 409 | INVALID_STATE: Chỉ đóng gói được đơn đã kiểm đạt |
| Kho nhận hàng | POST | `/api/warehouse/orders/24/receive` | 200 | stage=inspecting |
| Kiểm hàng: khớp mô tả | POST | `/api/warehouse/orders/24/inspect` | 200 | stage=inspected |
| Gửi đi trước khi đóng gói | POST | `/api/warehouse/orders/24/ship` | 409 | INVALID_STATE: Chỉ gửi đi được đơn đã đóng gói |
| Đóng gói | POST | `/api/warehouse/orders/24/pack` | 200 | stage=packed |
| Gửi cho đơn vị vận chuyển | POST | `/api/warehouse/orders/24/ship` | 200 | stage=shipped, mã GHNTEST0001 |
| Bidder xác nhận khi chưa giao | POST | `/api/orders/24/confirm-delivery` | 409 | NOT_DELIVERED: Đơn chưa được giao, chưa thể xác nhận |
| Giao thành công | POST | `/api/warehouse/orders/24/deliver` | 200 | stage=delivered, payoutDeadline=2026-10-12T15:28:24.420Z |
| Bidder 2 xác nhận đơn không phải của mình | POST | `/api/orders/24/confirm-delivery` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Bidder 1 xác nhận đã nhận hàng | POST | `/api/orders/24/confirm-delivery` | 200 | stage=completed, payoutStatus=released |
| Xác nhận lần hai | POST | `/api/orders/24/confirm-delivery` | 409 | ALREADY_CONFIRMED: Bạn đã xác nhận nhận hàng cho đơn này |
| Theo dõi đơn (người mua) | GET | `/api/orders/24/tracking` | 200 | packing -> shipped -> delivered |
| Seller nhận thông báo giải ngân | GET | `/api/notifications` | 200 | payout, sold, listing_approved, listing_needs_info |

## 5. Tranh chấp do Kho mở (hàng không khớp) -> Admin hoàn tiền

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "Bình gốm test BE2 (tranh chấp)" | POST | `/api/listings` | 201 | id=53 |
| Thêm ảnh | POST | `/api/listings/53/photos` | 201 | {"id":"53","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugg |
| Gửi thẩm định | POST | `/api/listings/53/submit` | 200 | {"id":"53","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugg |
| Duyệt | POST | `/api/appraisals/53/decision` | 201 | auctionId=46 |
| Đặt cọc | POST | `/api/auctions/46/join` | 201 | {"depositId":"81","deposit":100000,"balanceAfter":9900000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"134","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:28:27.155Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=25 |
| Thanh toán bằng ví | POST | `/api/orders/25/pay` | 200 | {"orderId":"25","paymentStatus":"paid","totalDue":1143000,"balanceAfter":8857000} |
| Seller gửi hàng về kho | POST | `/api/orders/25/ship-to-warehouse` | 200 | {"id":"25","auctionId":"46","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","payme |
| Kho nhận hàng | POST | `/api/warehouse/orders/25/receive` | 200 | {"id":"25","auctionId":"46","title":"Bình gốm test BE2 (tranh chấp)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","payme |
| Kiểm hàng: không khớp thiếu ghi chú | POST | `/api/warehouse/orders/25/inspect` | 400 | VALIDATION_ERROR: Ghi chú kiểm hàng không được để trống |
| Kiểm hàng: không khớp -> tự mở tranh chấp | POST | `/api/warehouse/orders/25/inspect` | 200 | stage=inspection_failed, payoutStatus=disputed |
| Không đóng gói được đơn đang tranh chấp | POST | `/api/warehouse/orders/25/pack` | 409 | INVALID_STATE: Chỉ đóng gói được đơn đã kiểm đạt |
| Bidder mở thêm tranh chấp khi đã có | POST | `/api/disputes` | 409 | DISPUTE_OPEN: Đơn này đang có tranh chấp chờ xử lý |
| Admin xem tranh chấp đang mở | GET | `/api/admin/disputes?status=open` | 200 | 4 tranh chấp mở |
| Admin phán quyết hoàn tiền | POST | `/api/admin/disputes/7/resolve` | 200 | status=resolved, resolution=refund, ký quỹ 1143000 |
| Ví người mua được hoàn qua wallet_service.refund (BE1) | — | `—` | — | balance 8857000 -> 10000000; wallet_transactions: refund 1143000, balance_after 10000000 |
| Phán quyết lần hai | POST | `/api/admin/disputes/7/resolve` | 409 | ALREADY_RESOLVED: Tranh chấp này đã được xử lý |

## 6. Tranh chấp do Bidder mở sau khi giao -> Admin giữ nguyên, giải ngân

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "Đồng hồ test BE2 (giữ nguyên)" | POST | `/api/listings` | 201 | id=54 |
| Thêm ảnh | POST | `/api/listings/54/photos` | 201 | {"id":"54","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Gửi thẩm định | POST | `/api/listings/54/submit` | 200 | {"id":"54","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Duyệt | POST | `/api/appraisals/54/decision` | 201 | auctionId=47 |
| Đặt cọc | POST | `/api/auctions/47/join` | 201 | {"depositId":"82","deposit":100000,"balanceAfter":8652000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"135","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:28:33.806Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=26 |
| Thanh toán bằng ví | POST | `/api/orders/26/pay` | 200 | {"orderId":"26","paymentStatus":"paid","totalDue":1143000,"balanceAfter":7609000} |
| Seller gửi hàng về kho | POST | `/api/orders/26/ship-to-warehouse` | 200 | {"id":"26","auctionId":"47","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kho nhận hàng | POST | `/api/warehouse/orders/26/receive` | 200 | {"id":"26","auctionId":"47","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kiểm hàng: khớp | POST | `/api/warehouse/orders/26/inspect` | 200 | {"id":"26","auctionId":"47","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Đóng gói | POST | `/api/warehouse/orders/26/pack` | 200 | {"id":"26","auctionId":"47","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Gửi đi | POST | `/api/warehouse/orders/26/ship` | 200 | {"id":"26","auctionId":"47","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Giao thành công | POST | `/api/warehouse/orders/26/deliver` | 200 | {"id":"26","auctionId":"47","title":"Đồng hồ test BE2 (giữ nguyên)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Bidder 2 mở tranh chấp đơn của người khác | POST | `/api/disputes` | 404 | NOT_FOUND: Không tìm thấy đơn hàng |
| Bidder mở tranh chấp | POST | `/api/disputes` | 201 | source=bidder, payoutStatus=disputed |
| Xác nhận nhận hàng khi đang tranh chấp | POST | `/api/orders/26/confirm-delivery` | 409 | DISPUTE_OPEN: Đơn đang có tranh chấp, chờ Admin xử lý |
| Admin phán quyết giữ nguyên | POST | `/api/admin/disputes/8/resolve` | 200 | resolution=keep, payoutStatus=released |

## 7. Tự giải ngân sau 72 giờ

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin "Radio test BE2 (tự giải ngân)" | POST | `/api/listings` | 201 | id=55 |
| Thêm ảnh | POST | `/api/listings/55/photos` | 201 | {"id":"55","title":"Radio test BE2 (tự giải ngân)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Gửi thẩm định | POST | `/api/listings/55/submit` | 200 | {"id":"55","title":"Radio test BE2 (tự giải ngân)","category":"antique","description":null,"condition":null,"startingPrice":1000000,"aiSugge |
| Duyệt | POST | `/api/appraisals/55/decision` | 201 | auctionId=48 |
| Đặt cọc | POST | `/api/auctions/48/join` | 201 | {"depositId":"83","deposit":100000,"balanceAfter":7509000} |
| Trả giá | POST | `/api/bids` | 201 | {"bidId":"136","currentPrice":1050000,"bidCount":1,"endsAt":"2026-10-10T15:28:41.527Z","extended":false} |
| Ép phiên hết giờ, closeAuction (BE1) | — | `—` | — | orderId=27 |
| Thanh toán bằng ví | POST | `/api/orders/27/pay` | 200 | {"orderId":"27","paymentStatus":"paid","totalDue":1143000,"balanceAfter":6466000} |
| Seller gửi hàng về kho | POST | `/api/orders/27/ship-to-warehouse` | 200 | {"id":"27","auctionId":"48","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kho nhận hàng | POST | `/api/warehouse/orders/27/receive` | 200 | {"id":"27","auctionId":"48","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Kiểm hàng: khớp | POST | `/api/warehouse/orders/27/inspect` | 200 | {"id":"27","auctionId":"48","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Đóng gói | POST | `/api/warehouse/orders/27/pack` | 200 | {"id":"27","auctionId":"48","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Gửi đi | POST | `/api/warehouse/orders/27/ship` | 200 | {"id":"27","auctionId":"48","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Giao thành công | POST | `/api/warehouse/orders/27/deliver` | 200 | {"id":"27","auctionId":"48","title":"Radio test BE2 (tự giải ngân)","category":"antique","finalPrice":1050000,"paymentStatus":"paid","paymen |
| Chưa tới hạn thì job không giải ngân | — | `—` | — | đơn vẫn payout_status = pending |
| Đơn đã tự giải ngân | GET | `/api/orders/27/tracking` | 200 | stage=completed, payoutStatus=released, deliveredConfirmedAt=null |

## 8. Phiên bị gắn cờ (fraud_detection của BE1) -> Admin xử lý

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Tạo tin | POST | `/api/listings` | 201 | {"id":"56","title":"Máy ảnh test BE2 (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000,"aiSuggestedPri |
| Thêm ảnh | POST | `/api/listings/56/photos` | 201 | {"id":"56","title":"Máy ảnh test BE2 (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000,"aiSuggestedPri |
| Gửi thẩm định | POST | `/api/listings/56/submit` | 200 | {"id":"56","title":"Máy ảnh test BE2 (gắn cờ)","category":"elec","description":null,"condition":null,"startingPrice":1000000,"aiSuggestedPri |
| Duyệt | POST | `/api/appraisals/56/decision` | 201 | {"appraisalId":"35","decidedAt":"2026-10-09T15:28:48.300Z","listingId":"56","decision":"approve","listingStatus":"live","auctionId":"49"} |
| Bidder 1 đặt cọc | POST | `/api/auctions/49/join` | 201 | {"depositId":"84","deposit":100000,"balanceAfter":6366000} |
| Bidder 2 đặt cọc | POST | `/api/auctions/49/join` | 201 | {"depositId":"85","deposit":100000,"balanceAfter":9900000} |
| 6 lượt giá xen kẽ giữa 2 tài khoản | — | `—` | — | kích hoạt luật "hai tài khoản đặt xen kẽ" của fraud_detection |
| Admin xem cờ đang chờ | GET | `/api/admin/flags?status=pending` | 200 | high 85: Chỉ hai tài khoản đặt giá xen kẽ nhau |
| Tạm dừng phiên | POST | `/api/admin/flags/15/action` | 200 | flag=paused |
| Đặt giá khi phiên tạm dừng | POST | `/api/bids` | 409 | AUCTION_PAUSED: Phiên đang bị tạm dừng để kiểm tra |
| Chuyển sang xác minh (bỏ tạm dừng) | POST | `/api/admin/flags/15/action` | 200 | flag=verify |
| Chấm dứt thiếu lý do | POST | `/api/admin/flags/15/action` | 400 | VALIDATION_ERROR: Lý do không được để trống |
| Chấm dứt phiên (cancelAuction của BE1) | POST | `/api/admin/flags/15/action` | 200 | flag=terminated, phiên=cancelled |
| Chấm dứt phiên hoàn cọc người tham gia | — | `—` | — | Bidder 1 held 100000 -> 0 |
| Xử lý cờ đã đóng | POST | `/api/admin/flags/15/action` | 409 | INVALID_STATE: Cờ này đã được xử lý xong |

## 9. Admin: bảng điều khiển, báo cáo, khoá tài khoản; Chatbot

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Bảng điều khiển | GET | `/api/admin/dashboard` | 200 | phiên live 6, tranh chấp mở 3, ký quỹ 33739000 |
| Báo cáo tuần | GET | `/api/admin/report/weekly` | 200 | 12 đơn, GMV 27150000 |
| Danh sách tài khoản (lọc theo từ khoá) | GET | `/api/admin/accounts?q=test_be2_1791559687274` | 200 | 3 tài khoản test |
| Khoá Bidder 2 | PATCH | `/api/admin/accounts/41` | 200 | status=suspended |
| Token cũ của tài khoản bị khoá | GET | `/api/me` | 403 | ACCOUNT_SUSPENDED: Tài khoản đã bị tạm khoá |
| Mở khoá Bidder 2 | PATCH | `/api/admin/accounts/41` | 200 | {"id":"41","fullName":"Người mua Hai","email":"test_be2_1791559687274_b2@example.com","status":"active"} |
| Token dùng lại được | GET | `/api/me` | 200 | {"id":"41","fullName":"Người mua Hai","email":"test_be2_1791559687274_b2@example.com","phone":null,"avatarUrl":null,"status":"active","role" |
| Khoá tài khoản Kho | PATCH | `/api/admin/ops-accounts/35` | 200 | status=suspended |
| Kho bị khoá gọi API | GET | `/api/warehouse/orders` | 403 | ACCOUNT_SUSPENDED: Tài khoản đã bị tạm khoá |
| Admin tự khoá chính mình | PATCH | `/api/admin/ops-accounts/33` | 409 | SELF_LOCKOUT: Không thể tự khoá hoặc tự bỏ quyền Admin của chính mình |
| Chatbot trả lời về đặt cọc | POST | `/api/chat/messages` | 201 | Để tham gia một phiên, bạn đặt cọc 10% giá khởi điểm (làm tròn nghìn) từ ví. Thu |
| Hỏi tiếp trong cùng phiên trò chuyện | POST | `/api/chat/messages` | 201 | Khi nhận được hàng, bạn bấm "Đã nhận hàng" để giải ngân cho người bán. Nếu không |
| Lịch sử trò chuyện | GET | `/api/chat/sessions/2/messages` | 200 | 4 tin nhắn |
| Người khác đọc lịch sử trò chuyện | GET | `/api/chat/sessions/2/messages` | 404 | NOT_FOUND: Không tìm thấy phiên trò chuyện |

## 10. Kiểm tra tính nhất quán của ví

| Bước | Method | Đường dẫn | Mã | Tóm tắt phản hồi |
|---|---|---|---|---|
| Số dư ví khớp balance_after của giao dịch cuối | — | `—` | — | cả hai Bidder test |
