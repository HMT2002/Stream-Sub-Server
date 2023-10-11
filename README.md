# Stream-Sub-Server
Lưu ý!!!
Muốn các hướng dẫn này có tác dụng thì phải tải FFMPEG và thêm vào đường dẫn hệ thống trước (system variables)
Còn nếu steaming không thôi thì có thể sử dụng OBS để stream lên server

    rtmp://localhost:1936/live/<Stream key của OBS>

Cần phải di chuyển vào folder server và bật server lên trước

    cd server
    npm start

Server được bật lên, tạo các file m3u8 hoặc mpd để xem video HLS, DASH, FLV.
Truy cập vào các đường dẫn để xem video

    http://localhost:9100/videos/convert/<Tên video>.m3u8
    http://localhost:9100/videos/<Tên của video>/init.mpd

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
