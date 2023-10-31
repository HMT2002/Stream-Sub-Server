chcp 65001
@echo off 
cls 
 
if not exist "%~1Hls" ( 
mkdir "%~1Hls"
echo Folder created.
 ) else ( 
echo Folder already exists! 
)
REM ffmpeg -i "%~1.mp4" ^
REM -profile:v baseline ^
REM -level 3.0 -start_number 0 -hls_time 10 -hls_list_size 0 ^
REM -f hls "convert\%~1.m3u8"
ffmpeg -i "%~1.mp4" ^
-level 3.0 -start_number 0 -hls_time 10 -hls_list_size 0 -hls_playlist_type vod ^
-hls_flags independent_segments ^
-map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 ^
-c:v libx265 -crf 22 -c:a aac -ar 44100 ^
-filter:v:0 scale=w=480:h=360  -maxrate:v:0 600k -b:a:0 500k ^
-filter:v:1 scale=w=640:h=480  -maxrate:v:1 1500k -b:a:1 1000k ^
-filter:v:2 scale=w=1280:h=720 -maxrate:v:2 3000k -b:a:2 2000k ^
-var_stream_map "v:0,a:0,name:360p v:1,a:1,name:480p v:2,a:2,name:720p" ^
-preset veryfast -hls_list_size 10 -threads 0 -f hls ^
-master_pl_name "%~1_master.m3u8" ^
-f hls "%~1Hls\%~1_%%v.m3u8"
