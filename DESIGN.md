---
name: Pacifico website
description: A narrow bilingual landing with serif lettering and theme-aware dithered waves.
---

# Pacifico website

## Direction

A single reading column makes the tool understandable and its installation easy to find. Preserve the owner's lowercase serif wordmark, Helvetica Neue body, square-cornered three-quarter-height ocean crop, concise bilingual copy, and footer-only navigation. The owner chose direct code construction and browser review.

## Layout and typography

The centered column is capped at 560px with 20px minimum side margins. The landing reads: artwork, wordmark, one-sentence introduction, installation, how it works, footer. Installation includes the exact command with a copy button beside it and a link to the full guide. The three steps use plain numbers and one sentence each.

Instrument Serif is self-hosted and reserved for `pacifico`. The main wordmark uses 38cqw, normal letter spacing, common ligatures, and a .95 line height so the `fi` joins naturally. Helvetica Neue, Helvetica, Arial, and sans-serif supply all other text, including commands. The intro is 21px, section headings 26px, and supporting copy 15–16px. At narrow widths the intro becomes 20px and command text 13px.

Keep artwork and lettering close. Separate the installation and explanation tasks with 48px gaps; keep steps 16px apart with a 12px number gutter and 16px text gap. The footer starts after 56px and its controls align with the column's left edge. Long commands wrap without moving the copy button below them. Copy targets are at least 44px tall.

## Themes

Every light background is pure white (#ffffff); every dark background is pure black (#000000). Light text, including supporting copy, uses the same blue as the video (#244ff4). Dark text uses white, with gray supporting text (#bdbdbd). Borders use #d8dbe7 in light and #333333 in dark.

Pink is the interactive accent: #9e297f on white for readable text and #e87fd2 on black. Focus outlines, selection, links, and the active language indicator use the palette. Commands share the page background. Do not add gradients, tinted panels, shadows, header navigation, or media toolbars.

## Artwork and provenance

The owner supplied two ocean clips, merged in order 1 then 2 into a 248-frame, 24fps, 10.33-second silent loop. `apps/site/scripts/prepare-video.py` preserves that source. `apps/site/scripts/dither-video.py` learns 24 color clusters using MiniBatchKMeans with a fixed seed, interpolates chroma weights, and applies a fixed 8×8 Bayer threshold grid. This is offline color clustering, not neural object recognition. `apps/site/dither-palette.json` records its learned centers and output colors.

The light loop replaces blue with white, foam with blue (#244ff4), and keeps pink (#e87fd2). The dark loop replaces blue with black, foam with white, and keeps pink. The PNG posters are the first processed frames. Every output derives from the supplied footage; no stock or newly generated footage is introduced.

The artwork keeps a 16:9 visible frame, three quarters of the height of the original 4:3 source, with a centered crop and square corners. A native video plays the prepared dithering; there is no ASCII layer, blur, or browser pixel processing. Only the active theme's loop loads. Theme changes preserve playback position and show the matching poster during loading.

## Behavior and accessibility

The theme follows the system until explicitly selected and persists across routes. Theme initialization precedes body rendering. Both languages share components, equivalent content, localized accessible labels, and correct guide-to-guide language links.

Offscreen or hidden video pauses. Reduced motion and JavaScript-free viewing show a matching static poster. Failed media leaves the poster visible with a short localized status. The decorative artwork has no visible playback controls, following the owner's brief.

Preserve the skip link, keyboard focus, readable contrast, native guide disclosures, and localized copy confirmation and manual-copy recovery. No animations are added to prose. Full installation, diagnostics, retention, troubleshooting, and command reference remain at `/guide/` and `/es/guide/`.
