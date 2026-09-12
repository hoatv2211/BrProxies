# Hướng dẫn BrProxies Bridge

BrProxies Bridge là Chrome extension Manifest V3 chạy cục bộ, gồm ba công cụ:

- Kết nối profile Account Keeper với Codex OAuth rồi export JSON cho 9Router hoặc Cockpit.
- Chuyển JSON Cockpit sang 9Router và ngược lại ngay trong popup.
- Xem, kiểm tra và sử dụng proxy sống từ BrProxies ProxyPool.

## Cách khuyên dùng: tự nạp theo profile

Không cần vào `chrome://extensions` nếu bạn dùng profile của BrProxies Browser.

1. Mở BrProxies, chọn **Browsers**.
2. Bấm **+ New profile** hoặc **Edit** một profile đang có.
3. Trong phần **Browser extensions**, tìm **BrProxies Bridge**.
4. Chọn **Include and auto-load**.
5. Bấm **Create profile** hoặc **Save changes**.
6. Bấm **Start** để mở profile. Nếu profile đang chạy, hãy stop rồi start lại.

Lựa chọn được lưu riêng cho từng profile:

- **Not included**: không tự nạp Bridge.
- **Include and auto-load**: tự nạp Bridge mỗi khi mở profile bình thường.

Khi clone hoặc export/import nguyên profile, cờ lựa chọn này đi cùng metadata
profile. Các phiên chạy automation/CDP của Account Keeper vẫn tắt extension để
không làm nhiễu quy trình tự động.

## Cài thủ công bằng Load unpacked

Cách này chỉ cần khi dùng Chrome ngoài BrProxies hoặc muốn kiểm tra extension
trực tiếp từ source.

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Bấm **Load unpacked**.
4. Chọn thư mục:

   `C:\Users\admin\Desktop\_AI\BrProxies\extension`

Thư mục được chọn phải chứa trực tiếp file `manifest.json`. Không chọn
`src-tauri\target\release\bundle`; đó là thư mục chứa installer Tauri nên Chrome
sẽ báo **Manifest file is missing or unreadable**.

## Chuẩn bị BrProxies

### Cho Codex Export

1. Chạy BrProxies.
2. Vào **Settings > Automation API**, bật API nếu đang tắt.
3. Copy **Bearer token** trong cùng phần Settings.
4. Vào **Account Keeper** và xác minh account.
5. Mở profile tương ứng và đăng nhập đúng tài khoản ChatGPT cần export.

Automation API mặc định chạy tại `http://127.0.0.1:40325`.

### Cho ProxyPool

1. Mở **ProxyPool** trong BrProxies.
2. Chạy collect/check cho đến khi có proxy sống.
3. Giữ ProxyPool service đang chạy.

ProxyPool API mặc định chạy tại `http://127.0.0.1:40326`.

## Export JSON cho 9Router hoặc Cockpit

1. Bấm biểu tượng **BrProxies Bridge** trên thanh extension.
2. Chọn tab **Codex Export**.
3. Giữ **BrProxies API URL** là `http://127.0.0.1:40325`.
4. Dán **Automation API Bearer token**.
5. Bấm **Connect BrProxies**.
6. Chọn một hoặc nhiều profile. Profile chưa có hoặc hết hạn credential vẫn chọn được.
7. Chọn định dạng **9Router** hoặc **Cockpit**.
8. Bấm **Connect & Export**.
9. Nếu tab OpenAI OAuth mở ra, xác nhận bằng tài khoản ChatGPT đang đăng nhập
   và phải khớp với profile Account Keeper đã chọn.
10. Chờ trang tiến trình tải JSON xuống, rồi import file đó vào 9Router/Cockpit.

Bearer token chỉ được giữ trong `chrome.storage.session` và mất khi session
Chrome kết thúc. Extension chỉ kết nối tới loopback `127.0.0.1` hoặc
`localhost`.

Extension không đọc cookie ChatGPT và không lấy token trực tiếp từ nội dung
trang web. Nó chỉ mở URL OAuth chính thức; BrProxies nhận callback PKCE, kiểm
tra email khớp profile và lưu credential trong vault được bảo vệ bằng DPAPI.

File export chứa OAuth token dạng plaintext. Hãy import sớm, không gửi file qua
kênh công khai và xoá bản không còn sử dụng.

## Chuyển JSON Cockpit và 9Router

Không cần bật Automation API cho chức năng chuyển đổi.

1. Mở Bridge và chọn tab **JSON Convert**.
2. Chọn chiều chuyển:
   - **Cockpit to 9Router**.
   - **9Router to Cockpit**.
3. Chọn file JSON hoặc dán JSON vào ô nhập.
4. Bấm **Convert & download**.

Công cụ chấp nhận một account object, một mảng account hoặc object có trường
`accounts`. Việc chuyển đổi chạy hoàn toàn trong popup, không upload dữ liệu và
không lưu credential vào Chrome storage. Sau khi tải thành công, nội dung nguồn
được xoá khỏi popup.

## Dùng ProxyPool trong Chrome

1. Mở Bridge và chọn tab **ProxyPool**.
2. Giữ **Pool API URL** là `http://127.0.0.1:40326`.
3. Bấm **Connect**.
4. Dùng các nút:
   - **Test live**: kiểm tra lại proxy.
   - **Use**: áp dụng proxy được chọn cho Chrome.
   - **Rotate**: chuyển sang proxy sống khác.
   - **Direct**: bỏ proxy và dùng kết nối trực tiếp.

Proxy có username/password hiện chưa được hỗ trợ trong extension.

## Xử lý lỗi thường gặp

### Manifest file is missing or unreadable

Bạn đã chọn sai thư mục. Với **Load unpacked**, chọn thư mục `extension` chứa
trực tiếp `manifest.json`, không chọn thư mục `bundle`.

### Profile mở nhưng không thấy Bridge

- Mở **Edit > Browser extensions** và kiểm tra đang chọn
  **Include and auto-load**.
- Stop profile rồi start lại; extension không được thêm vào tiến trình đang chạy.
- Build lại BrProxies nếu bản executable cũ chưa chứa thư mục
  `bridge-extension`.

### Connect BrProxies báo 401

Copy lại Bearer token từ **Settings > Automation API**. Không dùng token cũ nếu
BrProxies đã tạo token mới.

### Không thấy profile để export

Profile phải được Account Keeper xác minh. Credential Codex có thể đang thiếu;
khi bấm **Connect & Export**, extension sẽ tự mở OAuth để kết nối.

### OAuth thất bại

Kiểm tra tài khoản ChatGPT đang đăng nhập trong profile hiện tại có đúng email
đã được Account Keeper ánh xạ hay không. Sau đó bấm **Try again** trên trang
tiến trình.

### ProxyPool không có dữ liệu

Mở ProxyPool trong BrProxies, chạy collect/check và xác nhận service tại cổng
`40326` đang hoạt động. Proxy miễn phí có thể biến mất hoặc fail bất kỳ lúc nào.

## Giới hạn và bảo mật

- Bridge chỉ cho phép API loopback; không kết nối API BrProxies ở máy từ xa.
- JSON OAuth export là secret dạng plaintext.
- Extension tự khởi động OAuth nhưng không thay thế bước xác minh Account Keeper.
- Tài khoản OAuth phải khớp profile được chọn; nhiều profile được xử lý lần lượt.
- Automation/CDP launch không nạp extension.
- BrProxies và service tương ứng phải đang chạy khi dùng Codex Export hoặc ProxyPool.
