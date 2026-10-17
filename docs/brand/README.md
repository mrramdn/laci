# Laci's mark

*Laci* is Indonesian for "drawer". The mark is an open drawer: a teak cabinet with its drawer pulled out, two project folders inside and a cup pull, on a turmeric plate. No app nearby uses an open drawer or yellow, so it stays recognisable next to file managers and coding tools.

![The mark and the wordmark](src/laci-lockup.svg)

## Colours

Named for Indonesian things: *kunyit* is turmeric, *jati* is teak, *santan* is coconut milk, *malam* is night.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| Plate | kunyit `#FFD34E` → `#F4AC1A` | malam `#231D17` → `#14100C` | The plate behind the glyph |
| Plate, small | `#F9BF33` | | Flat plate at 32 px and below, where a gradient only blurs |
| Edge | `#D9940A` | | The darker front edge of the Linux icon |
| Cabinet and drawer | jati `#3B2A1E` | kunyit `#FFC83D` | Frame, drawer front, wordmark on light |
| Opening | `#140D09` | `#0B0806` | Inside the cabinet |
| Folder | santan `#FFF5DF` | `#FFF5DF` | Front folder, wordmark on dark |
| Card | `#E9D3A6` | `#E9D3A6` | The card behind the folder |

- Turmeric is the mark's colour only. It is never an interface accent or a status colour: it is too close to the warning amber of both designs.
- Never put santan directly on kunyit (1.5:1) or kunyit text on white (1.6:1).
- Jati on the plate is 7.0:1 at its lightest; santan on the opening is 17.7:1.

## Files

Everything in `src/` is written by `scripts/brand-icons.mjs` from one description of the glyph. Change the script, not the files.

| File | What it is |
| --- | --- |
| `laci-glyph.svg` | The glyph alone on a 1024 grid, in three groups (cabinet, contents, drawer) for macOS 26 layered icons |
| `laci-icon-linux.svg` | The Linux icon: rounded square with a darker front edge |
| `laci-icon-macos.svg` | The macOS icon on Apple's template body and shadow |
| `laci-icon-tight.svg` | Plate nearly filling the square: Windows frames from 36 px, the web and the app |
| `laci-icon-tight-dark.svg` | The dark appearance |
| `laci-16.svg` … `laci-32.svg` | The small sizes, drawn on the pixel grid |
| `laci-symbolic.svg` | One colour on a 16 px grid, `currentColor`: GNOME's symbolic icon, tinted places |
| `laci-wordmark.svg` | "laci" in Plus Jakarta Sans Bold, −0.02 em, as outlines |
| `laci-lockup.svg`, `laci-lockup-dark.svg` | Mark and wordmark, for light and dark backgrounds |

The script also writes `ui/public/favicon.svg` and `ui/src/brand-marks.ts`, which the app's `LaciMark` draws inline.

```sh
node scripts/brand-icons.mjs                          # the sources above
node scripts/brand-icons.mjs --icons src-tauri/icons  # the app icon set: PNG, ICO, ICNS, SVG
node scripts/brand-icons.mjs --sheet /tmp/laci.png    # a review sheet on light and dark
node scripts/brand-icons.mjs --font PlusJakartaSans-Bold.ttf  # outline the wordmark again
```

Rendering needs `resvg` and ImageMagick's `magick`; the ICNS file comes from the Tauri CLI. The ICO holds frames from 16 to 256 px, smallest first; 16, 20, 24, 30 and 32 px are the pixel-grid drawings, and 256 is PNG-compressed.

## Using it

- **Wordmark.** Always lowercase "laci". In running text the app is "Laci".
- **Lockup.** The "l" is 0.70 of the mark's height and stands on the drawer's bottom edge. Keep a quarter of the mark's height clear around the lockup.
- **Small sizes.** Use the pixel-grid drawings at 32 px and below; on dense screens the app switches to the vector master by itself.
- **In the interface.** The mark is a filled tile, so it never reads as one of the line icons around it. The Archive action keeps its own archive icon.
- **Licence.** Laci's code is MIT. The name and the mark are not covered by that licence. Plus Jakarta Sans is © The Plus Jakarta Sans Project Authors, under the SIL Open Font License 1.1.
