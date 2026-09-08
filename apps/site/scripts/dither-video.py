"""Learn the footage palette and render theme-specific ordered-dither loops.

Run with Python 3, numpy, scikit-learn, Pillow, and ffmpeg installed:
    python scripts/dither-video.py
Only asset preparation uses machine learning; playback needs no model or canvas.
"""
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.cluster import MiniBatchKMeans

SITE = Path(__file__).resolve().parents[1]
MEDIA = SITE / 'public/media'
SOURCE = MEDIA / 'pacifico-loop.mp4'
WIDTH, HEIGHT, FPS = 384, 288, 24


def decode(filters):
    return subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(SOURCE), '-vf', filters,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ])


# Fit once across the whole loop to avoid palette changes between frames.
samples = np.frombuffer(decode('fps=2,scale=96:72'), dtype=np.uint8).reshape(-1, 3)
model = MiniBatchKMeans(n_clusters=24, random_state=7, n_init=3, batch_size=4096)
model.fit(samples.astype(np.float32) / 255)
centers = model.cluster_centers_


def smoothstep(low, high, x):
    x = np.clip((x - low) / (high - low), 0, 1)
    return x * x * (3 - 2 * x)


# Chroma weights replace blue with paper and foam with ink, preserving pink.
# Interpolation between learned centers keeps the moving contours continuous.
def weights(rgb):
    r, g, b = rgb.T
    warm = smoothstep(.24, .82, r / np.maximum(b, .01))
    foam = smoothstep(.48, .87, g) * warm
    pink = warm * (1 - foam) * .92
    return np.stack((1 - foam - pink, foam, pink), axis=-1)


# A compact RGB lookup interpolates four learned neighbors per color.
levels = 32
cube = np.indices((levels, levels, levels)).reshape(3, -1).T / (levels - 1)
distances = ((cube[:, None] - centers[None]) ** 2).sum(axis=-1)
nearest = np.argsort(distances, axis=1)[:, :4]
inverse = 1 / np.maximum(np.take_along_axis(distances, nearest, axis=1), .0001)
inverse /= inverse.sum(axis=1, keepdims=True)
lookup = (weights(centers)[nearest] * inverse[..., None]).sum(axis=1)

# A fixed Bayer grid keeps the stipple anchored while the waves move through it.
bayer = np.array([[0, 2], [3, 1]])
for _ in range(2):
    bayer = np.block([[4 * bayer, 4 * bayer + 2], [4 * bayer + 3, 4 * bayer + 1]])
threshold = np.tile((bayer + .5) / 64, (HEIGHT // 8, WIDTH // 8))
palettes = {
    'light': np.array([[255, 255, 255], [36, 79, 244], [232, 127, 210]], dtype=np.uint8),
    'dark': np.array([[0, 0, 0], [255, 255, 255], [232, 127, 210]], dtype=np.uint8),
}
frames = np.frombuffer(decode(f'scale={WIDTH}:{HEIGHT}'), dtype=np.uint8).reshape(-1, HEIGHT, WIDTH, 3)
writers = {}
for theme in palettes:
    writers[theme] = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', f'{WIDTH}x{HEIGHT}', '-r', str(FPS), '-i', '-', '-an',
        '-vf', 'scale=768:576:flags=neighbor', '-c:v', 'libx264', '-preset', 'slow',
        '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        str(MEDIA / f'pacifico-{theme}.mp4'),
    ], stdin=subprocess.PIPE)
for index, frame in enumerate(frames):
    quantized = (frame.astype(np.uint16) * (levels - 1) // 255).astype(np.int32)
    color = lookup[quantized[..., 0] * levels ** 2 + quantized[..., 1] * levels + quantized[..., 2]]
    labels = np.where(threshold < color[..., 0], 0, np.where(threshold < color[..., 0] + color[..., 1], 1, 2))
    for theme, palette in palettes.items():
        result = palette[labels]
        writers[theme].stdin.write(result.tobytes())
        if index == 0:
            Image.fromarray(result).resize((768, 576), Image.Resampling.NEAREST).save(MEDIA / f'pacifico-{theme}-poster.png')
    if index % 48 == 0:
        print(f'Rendered {index + 1}/{len(frames)} frames', flush=True)
for writer in writers.values():
    writer.stdin.close()
    if writer.wait() != 0:
        raise RuntimeError('Video encoding failed')
(SITE / 'dither-palette.json').write_text(json.dumps({
    'method': 'MiniBatchKMeans color clustering, interpolated chroma weights, 8x8 Bayer dithering',
    'seed': 7, 'clusters': 24, 'frames': len(frames), 'fps': FPS,
    'learnedColors': (centers * 255).round().astype(int).tolist(),
    'outputPalettes': {theme: palette.tolist() for theme, palette in palettes.items()},
}, indent=2) + '\n')
