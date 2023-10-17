chcp 65001
@echo off 
cls 
 
if not exist "%~1Hls" ( 
mkdir "%~1Hls"
echo Folder created.
 ) else ( 
echo Folder already exists! 
)
REM ffmpeg -i "%~1.mkv" ^
rem -profile:v baseline ^
rem -level 3.0 -start_number 0 -hls_time 10 -hls_list_size 0 ^
rem -f hls "convert\%~1.m3u8"
ffmpeg -i "%~1.mkv" ^
-c:v copy ^
-c:a copy ^
-level 3.0 -start_number 0 -hls_time 10 -hls_list_size 0 ^
-f hls "%~1Hls\%~1.m3u8"