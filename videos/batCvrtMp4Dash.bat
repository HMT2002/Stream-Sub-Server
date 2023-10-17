chcp 65001
@echo off 
cls 
 
if not exist "%~1Dash" ( 
mkdir "%~1Dash"
echo Folder created.
 ) else ( 
echo Folder already exists! 
)
REM ffmpeg -re -i "%1.mp4" -map 0 -map 0 ^
REM -c:a copy ^
REM -c:v copy ^
REM -b:v:0 1000k -b:v:1 300k -s:v:1 320x170 ^
REM -profile:v:1 baseline -profile:v:0 main ^
REM -bf 1 -keyint_min 120 -g 120 -sc_threshold 0 -b_strategy 0 -ar:a:1 22050 ^
REM -use_timeline 1 -single_file 0 -use_template 1 -seg_duration 5 -adaptation_sets "id=0,streams=v id=1,streams=a" ^
REM -f dash "%1/init.mpd"

ffmpeg -re -i "%~1.mp4" -map 0 -map 0 -preset ultrafast ^
-c:a copy ^
-c:v copy ^
-b:v:0 1000k -b:v:1 300k -s:v:1 320x170 ^
-bf 1 -keyint_min 120 -g 120 -sc_threshold 0 -b_strategy 0 -ar:a:1 22050 ^
-use_timeline 1 -single_file 0 -use_template 1 -seg_duration 10 -adaptation_sets "id=0,streams=v id=1,streams=a" ^
-f dash "%~1Dash/init.mpd"