# Pacifico website

A bilingual static landing page built with Astro, React, and Tailwind CSS. English is available at `/`, and Spanish at `/es/`.

## Development

```sh
bun install --frozen-lockfile
bun run dev
```

```sh
bun run check
bun run build
bun run preview
```

The CLI and this app use separate dependency trees and lockfiles. Run these commands from `apps/site`.

## Structure

- `src/components/Landing.astro` renders both languages from one layout.
- `src/data/content.ts` contains the English and Spanish copy.
- `src/components/CopyCommand.tsx` provides React clipboard controls, visible confirmation, and manual-copy recovery when clipboard access fails.
- `src/styles/global.css` combines Tailwind utilities with the site typography and component styles.
- `src/layouts/Page.astro` provides language, metadata, and canonical/alternate URLs.

Instrument Serif is self-hosted through Fontsource under SIL OFL. Other text uses Helvetica Neue where installed, followed by Helvetica, Arial, and sans-serif. The proprietary Helvetica font files are not redistributed.

## Hosting

The website is hosted on Cloudflare Workers Static Assets at [pacifico.emersoftware.cl](https://pacifico.emersoftware.cl/). The custom domain, static assets, and 404 handling are declared in `wrangler.jsonc`. Public workers.dev and preview URLs are disabled.

To deploy from this directory with an authorized Cloudflare account:

```sh
bun run deploy
```

The command checks and builds the site before uploading it. Wrangler manages the custom domain and its certificate. `SITE_URL` and `SITE_BASE` can override the default origin and root path for other environments. No third-party analytics or remote font requests are included.

## Verification

Check both languages on desktop and narrow mobile screens. Verify installation and multiline clipboard content, recovery disclosures, keyboard focus, reduced motion, and internal anchor navigation. The page remains readable without JavaScript; copying manually is always possible.

## Video and color palette

`public/media/pacifico-loop.mp4` joins the owner's clips in order 1, then 2: 248 frames, 24 fps, 768 × 576, 10.33 seconds. Audio is omitted for the decorative loop. The original aspect ratio and colors are preserved.

Rebuild the original loop with `python3 scripts/prepare-video.py <clip-1> <clip-2>` (requires FFmpeg). The source clips were supplied by the owner. No generated replacement footage is used.

Run `python scripts/dither-video.py` with NumPy, scikit-learn, Pillow, and FFmpeg installed to produce the two themed loops and PNG posters. MiniBatchKMeans learns 24 color clusters across the complete loop with a fixed seed. Interpolated chroma weights separate the blue base, pale foam, and pink; a fixed 8×8 Bayer grid converts their proportions to three-color dithering. The light palette is white, blue, and pink. The dark palette is black, white, and pink. `dither-palette.json` records the learned centers and output palettes. This is offline color clustering, not a neural segmentation model.

Both outputs preserve the source's frame count, timing, and clip order. The browser loads only the active theme's video, switches at the current playback position, and uses a matching static poster while loading or if playback fails. Playback pauses offscreen and in hidden tabs. Reduced motion and JavaScript-free viewing show the themed poster. There is no canvas processing, ASCII library, model download, or visible media toolbar.

Theme selection follows the system until the user chooses light or dark and persists across routes. Page and command backgrounds are pure white in light mode and pure black in dark mode. Pink links use a darker shade on white to maintain text contrast.

## Landing and full guide

The landing places installation after the short introduction, followed by three single-sentence steps. Full requirements, setup, background imports, diagnostics, troubleshooting, data retention, and command reference live at `/guide/` and `/es/guide/`. The footer language switch stays on the corresponding page. The video sits above the wordmark with square corners.
