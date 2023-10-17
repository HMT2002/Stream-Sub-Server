chcp 65001
ffmpeg -stream_loop -1 -y -re -i "%~1.mp4" -loop -1 ^
-c:a copy ^
-c:v copy ^
-ar 44100 -ac 2 ^
-strict -2 -f  rtp_mpegts -fec prompeg=l=8:d=4 "rtp://%2/%~1"
::ffmpeg -stream_loop -1 -y -re -i "%~1.mp4" -loop -1 -an -c:v copy -f rtp -sdp_file video.sdp "rtp://%2/%~1"