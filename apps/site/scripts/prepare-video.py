"""Join the two source clips and measure mean colors by hue family.

Usage: python3 scripts/prepare-video.py '/path/video 1.mp4' '/path/video 2.mp4'
Requires ffmpeg. No Python packages are required.
"""
import colorsys
import json
from pathlib import Path
import subprocess
import sys

site = Path(__file__).resolve().parents[1]
output = site / 'public/media'
output.mkdir(parents=True, exist_ok=True)
first, second = sys.argv[1:]
video = output / 'pacifico-loop.mp4'
subprocess.run([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', first, '-i', second,
    '-filter_complex', '[0:v:0]setpts=PTS-STARTPTS[v0];[1:v:0]setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '21', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', str(video),
], check=True)
subprocess.run([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(video),
    '-frames:v', '1', '-q:v', '2', '-y', str(output / 'pacifico-poster.jpg'),
], check=True)
raw = subprocess.check_output([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(video),
    '-vf', 'fps=2,scale=96:72', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
])
groups = {key: [] for key in ('white', 'blue', 'pink')}
for i in range(0, len(raw), 3):
    rgb = tuple(raw[i:i + 3])
    hue, saturation, value = colorsys.rgb_to_hsv(*(x / 255 for x in rgb))
    if value > .8 and saturation < .22:
        groups['white'].append(rgb)
    elif .52 < hue < .72 and saturation > .55:
        groups['blue'].append(rgb)
    elif (hue > .78 or hue < .03) and saturation > .25 and value > .55:
        groups['pink'].append(rgb)
palette = {
    key: {
        'hex': '#' + ''.join(f'{round(sum(c[j] for c in pixels) / len(pixels)):02x}' for j in range(3)),
        'samples': len(pixels),
    }
    for key, pixels in groups.items() if pixels
}
(site / 'video-palette.json').write_text(json.dumps(palette, indent=2) + '\n')
print(json.dumps(palette, indent=2))
