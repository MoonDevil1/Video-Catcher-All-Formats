#!/usr/bin/env python3
"""Combine original audio and video using locally installed FFmpeg (no transcoding)."""
import argparse, subprocess, shutil, sys
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('video',type=Path); p.add_argument('audio',type=Path); p.add_argument('-o','--output',type=Path,default=Path('VideoCatcher-combined.mkv'))
a=p.parse_args()
if not shutil.which('ffmpeg'): sys.exit('Install FFmpeg first: https://ffmpeg.org/')
for f in [a.video,a.audio]:
 if not f.is_file():sys.exit(f'File not found: {f}')
if a.output.resolve() in (a.video.resolve(),a.audio.resolve()):sys.exit('Output cannot overwrite an input')
cmd=['ffmpeg','-hide_banner','-i',str(a.video),'-i',str(a.audio),'-map','0:v:0','-map','1:a:0','-c','copy','-y',str(a.output)]
raise SystemExit(subprocess.run(cmd,check=False).returncode)
