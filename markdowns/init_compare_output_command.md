mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:480[a];[vid4]scale=-2:480[b];[a][b]hstack[vo]" --demuxer-lavf-o=allowed_extensions=ALL
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:720[a];[vid4]scale=-2:720[b];[a][b]hstack[vo]" --demuxer-lavf-o=allowed_extensions=ALL
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid3]scale=-2:1080[a];[vid4]scale=-2:1080[b];[a][b]hstack[vo]" --demuxer-lavf-o=allowed_extensions=ALL


mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:480[a];[vid4]scale=-2:480[b];[a][b]vstack[vo]" --demuxer-lavf-o=allowed_extensions=ALL
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:720[a];[vid4]scale=-2:720[b];[a][b]vstack[vo]" --demuxer-lavf-o=allowed_extensions=ALL
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid3]scale=-2:1080[a];[vid4]scale=-2:1080[b];[a][b]vstack[vo]" --demuxer-lavf-o=allowed_extensions=ALL



ffmpeg -i init.mpd -allowed_extensions ALL -i init.mp4 -lavfi "[0:v]scale=1[enc];[enc][1:v]libvmaf" -f null -

ffmpeg -i init.mpd -allowed_extensions ALL -i init.mp4 -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]psnr=stats_file=psnr.log" -f null -


ffmpeg -i init.mpd -allowed_extensions ALL -i init.mp4 -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]libvmaf=feature=name=psnr|name=float_ssim|name=ciede:log_path=vmaf.json:log_fmt=json" -f null -

# Trong các mức ≤480p, chọn mức cao nhất = đúng 480p
vlc --adaptive-logic=highest --adaptive-maxheight=480 master.mpd

# Trích 1 frame 480p để soi pixel-true, không upscale
ffmpeg -i 480p/index.mpd -allowed_extensions ALL -vf "select=eq(n\,500)" -vframes 1 frame_480.png


ffprobe -hide_banner init.mpd
# hoặc xem trong mpv: mở rồi bấm phím để liệt kê, hoặc:
mpv --msg-level=all=v init.mpd 2>&1 | findstr "Video"


mpv --vid=2 init.mpd      # số 2 = ví dụ, thay bằng index track 480p thực tế