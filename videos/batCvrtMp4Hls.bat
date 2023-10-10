chcp 65001
@echo off 
cls 
 
if not exist convert ( 
mkdir convert
echo Folder created.
 ) else ( 
echo Folder already exists! 
)
ffmpeg -i "%1.mp4" -profile:v baseline -level 3.0 -start_number 0 -hls_time 10 -hls_list_size 0 -f hls "convert\%1.m3u8"