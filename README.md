# Stream-Sub-Server
*Hướng dẫn cuối kỳ!!!*
*Đây là hướng dẫn cài đặt mới nhất của Sub Server, dùng để deploy server lên VPS để phục vụ việc streaming cho ứng dụng mobile và web*

Hướng dẫn deploy cho VPS hệ điều hành Ubuntu 20.04.6, máy ảo mới, chưa được cài đặt.
Cần phải cài đặt các môi trường, phần mềm cần thiết trước khi deploy.
Bên trong git có 1 file scripts, chứa các lệnh để cài đặt nếu bạn chưa biết, hoặc biết rồi nhưng lười thì copy paste, chạy LẦN LƯỢT từng lệnh luôn cho lẹ.

*Sau đây là giải thích chi tiết, ai không quan tâm thì cứ bỏ qua, copy paste lệnh là deploy được.*

Đầu tiên là apt-get update là để lấy các cập nhật hệ thống, việc này đương nhiên ai cũng phải làm nếu muốn deploy lên VPS rồi.
Sau đó là cài đặt nginx, cài đặt môi trường để chạy server, ở đây là node 20.
Sau khi cài đặt nginx, ta thiết lập cài đặt, cấu hình. Trong git có file nginx.conf và streaming, đây là 2 file cấu hình cho nginx, bỏ vào folder gốc của nginx, sau đó test và  restart nginx để nhận cấu hình mới
Cài đặt các node_modules bằng npm install, và cài đặt thêm 1 gói mới là pm2, gói này mở cho server chạy liên tục thay vì tắt khi màn hình terminal mất đi.
Thế là bạn đã có thể streaming dựa trên địa chỉ IP của VPS, cổng mặc định là 9100 được cài đặt trong cấu hình nginx và server nodejs.

*Thế là đã có 1 Sub Server để phục vụ việc lưu trữ, xử lý phân tán dữ liệu và streaming phim, tuy có thể sử dụng đơn lẻ các API của Sub server, nhưng các API đó được tổng hợp cùng các server của hệ thống và sử dụng thuận tiện hơn ở Central Server, cũng có repo riêng https://github.com/HMT2002/SE400.O12.PMCL , đọc thông tin, hướng dẫn chi tiết bên đó*

---------------------------------------------------
*Hướng dẫn cũ* 
*(Các chức năng bên dưới vẫn có thể sử dụng nhưng không được update nữa)*

Lưu ý!!!
Muốn các hướng dẫn này có tác dụng thì phải tải FFMPEG và thêm vào đường dẫn hệ thống trước (system variables)
Còn nếu steaming không thôi thì có thể sử dụng OBS để stream lên server

    rtmp://localhost:1936/live/<Stream key của OBS>

Cần phải di chuyển vào folder server và bật server lên trước

    cd server
    npm start

Server được bật lên, tạo các file m3u8 hoặc mpd để xem video HLS, DASH, FLV.
Không thì download video test ở đây luôn cũng được.
https://drive.google.com/file/d/1bV1_ObTIWUqQ_q_kbIOSUSWvXBKfHTTR/view?usp=sharing
Giải nén ra folder `videos/`
Truy cập vào các đường dẫn để xem video

    http://localhost:9100/videos/<Tên video>Hls/<Tên video>.m3u8
    http://localhost:9100/videos/<Tên của video>Dash/init.mpd
    http://localhost:9100/videos/flyingwitch_ep01Hls/flyingwitch_ep01.m3u8 (nếu dùng folder test bên trên)

(1936 = 1935 + SERVERINDEX)
Để tạo folder Hls hoặc Dash thì dùng các command có sẵn

    batCvrtMp4Dash.bat <tên video cùng folder file batch>

Các từng loại command dành cho từng loại file, từng loại định dạng muốn đổi qua

    Mp4Dash: từ file mp4 thành list Dash
    Mp4Hls: từ file mp4 thành list Hls
    MkvDash: từ file mkv thành list Dash
    ...

Và còn các APIs khác dùng để tạo bản sao, xóa video dựa trên server khác nhau.
Backend chỉ làm nhiệm vụ điều hướng, Server sẽ là các server chịu tải, chịu lỗi. Copy folder server ra, đổi SERVERINDEX trong file config.env

Server RTMP có thể được stream trên các port 1935 + SERVERINDEX của server

Khi chạy npm start server thì là bật 1 server host live streaming, muốn có video streaming thì phải tạo luồng (stream) và chiếu lên host đó. Không biết lệnh thì có sẵn command line luôn.

    rtmpMp4IP.bat <tên video> localhost:1936

Còn không thì có thể dùng OBS để stream trên PC, Laris Broadcaster nếu dùng Android, xem hướng dẫn bên đó.
 Lưu ý là chỉ có các trình duyệt, phần mềm nhất định mới hỗ trợ redirect phương thức HTTP thành RTMP, nghĩa là chỉ có phần mềm chẳng hạn như VLC có thể truy cập vào đường dẫn redirect live stream của backend.
    
    rtmp://localhost:1936/live/<stream key, nếu dùng bat bên trên thì nó là tên video>
-------------------------------------------------------------

<!-- 
                       _oo0oo_
                      o8888888o
                      88" . "88
                      (| -_- |)
                      0\  =  /0
                    ___/`---'\___
                  .' \\|     |// '.
                 / \\|||  :  |||// \
                / _||||| -:- |||||- \
               |   | \\\  -  /// |   |
               | \_|  ''\---/''  |_/ |
               \  .-\__  '-'  ___/-. /
             ___'. .'  /--.--\  `. .'___
          ."" '<  `.___\_<|>_/___.' >' "".
         | | :  `- \`.;`\ _ /`;.`/ - ` : | |
         \  \ `_.   \_ __\ /__ _/   .-` /  /
     =====`-.____`.___ \_____/___.-`___.-'=====
                       `=---='


     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 
                    HMT2002 copyright@
                        Hồ Minh Tuệ
-->