chcp 65001
ffmpeg -stream_loop -1 -y -re -i "%~1.mp4" -vcodec copy -loop -1 -c:a aac -b:a 160k -ar 44100 -strict -2 -f flv "rtmp:%2/live/%~1"
:: Rem hiểu rồi, rtmp:localhost/live/bbb nghĩa là chỉ chiếu trên application live bên file nginx.conf, không chiếu trên application khác