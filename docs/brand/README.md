# Laci's mark

*Laci* is Indonesian for "drawer". The mark is an open drawer: a teak cabinet with its drawer pulled out, two project folders inside and a cup pull, on a turmeric plate. No app nearby uses an open drawer or yellow, so it stays recognisable next to file managers and coding tools.

![The mark and the wordmark](src/laci-lockup.svg)

## Colours

Named for Indonesian things: *kunyit* is turmeric, *jati* is teak, *santan* is coconut milk, *malam* is night.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| Plate | kunyit `#FFD34E` → `#F4AC1A` | malam `#231D17` → `#14100C` | The plate behind the glyph |
| Plate, small | `#F9BF33` | | Flat plate at 32 px and below, where a gradient only blurs |
| Edge | `#D9940A` | | The darker front edge of the app icon |
| Cabinet and drawer | jati `#3B2A1E` | kunyit `#FFC83D` | Frame, drawer front, wordmark on light |
| Opening | `#140D09` | `#0B0806` | Inside the cabinet |
| Folder | santan `#FFF5DF` | `#FFF5DF` | Front folder, wordmark on dark |
| Card | `#E9D3A6` | `#E9D3A6` | The card behind the folder |

- Turmeric is the mark's colour only. It is never an interface accent or a status colour: it is too close to the warning amber of both designs.
- Never put santan directly on kunyit (1.5:1) or kunyit text on white (1.6:1).
- Jati on the plate is 7.0:1 at its lightest; santan on the opening is 17.7:1.

### In Simple

Simple's accent comes from the mark ("Jati & santan"). `ui/src/simple/tokens.css` holds the values, and `scripts/contrast-check.mjs` checks them.

| Use | Light | Dark |
| --- | --- | --- |
| Filled button | santan `#FFF5DF` on jati `#3B2A1E` (12.6:1) | malam `#231D17` on `#F2E2C4` (13.1:1) |
| Links, underlined, and the focus ring | `#6B4423` (8.0:1 on the page `#FBF8F3`) | `#EBD3A6` (12.5:1 on `#181512`) |
| The chosen place | jati on `#F1E6D3` (11.1:1) | `#F2E2C4` on `#2C2219` (12.2:1) |
| Safe, leaf green (*daun*) | `#2F6B3F` on `#E8F0E4` (5.5:1) | `#8CC79A` on `#1D2A20` (7.7:1) |

Kunyit stays out of the interface there too. Simple's illustrations, which only decorate, may use all four: jati lines, kunyit and santan fills in light, kunyit lines on malam in dark.

## Files

Everything in `src/` is written by `scripts/brand-icons.mjs` from one description of the glyph. Change the script, not the files.

| File | What it is |
| --- | --- |
| `laci-glyph.svg` | The glyph alone on a 1024 grid, in three groups (cabinet, contents, drawer) |
| `laci-icon-linux.svg` | The app icon: rounded square with a darker front edge |
| `laci-icon-tight.svg` | Plate nearly filling the square: the web and the app |
| `laci-icon-tight-dark.svg` | The dark appearance |
| `laci-16.svg`, `laci-24.svg`, `laci-32.svg` | The small sizes, drawn on the pixel grid |
| `laci-symbolic.svg` | One colour on a 16 px grid, `currentColor`: GNOME's symbolic icon, tinted places |
| `laci-wordmark.svg` | "laci" in Plus Jakarta Sans Bold, −0.02 em, as outlines |
| `laci-lockup.svg`, `laci-lockup-dark.svg` | Mark and wordmark, for light and dark backgrounds |

The script also writes `ui/public/favicon.svg` and `ui/src/brand-marks.ts`, which the app's `LaciMark` draws inline.

```sh
node scripts/brand-icons.mjs                          # the sources above
node scripts/brand-icons.mjs --icons src-tauri/icons  # the app icon set: PNG, SVG
node scripts/brand-icons.mjs --sheet /tmp/laci.png    # a review sheet on light and dark
node scripts/brand-icons.mjs --font PlusJakartaSans-Bold.ttf  # outline the wordmark again
```

Rendering needs `resvg` and ImageMagick's `magick`. The icon set holds PNGs from 16 to 512 px, where 16, 24 and 32 px are the pixel-grid drawings, and the SVG and symbolic icons.

## Using it

- **Wordmark.** Always lowercase "laci". In running text the app is "Laci".
- **Lockup.** The "l" is 0.70 of the mark's height and stands on the drawer's bottom edge. Keep a quarter of the mark's height clear around the lockup.
- **Small sizes.** Use the pixel-grid drawings at 32 px and below; on dense screens the app switches to the vector master by itself.
- **In the interface.** The mark is a filled tile, so it never reads as one of the line icons around it. The Archive action keeps its own archive icon.
- **Licence.** Laci's code is MIT. The name and the mark are not covered by that licence. Plus Jakarta Sans is © The Plus Jakarta Sans Project Authors, under the SIL Open Font License 1.1.
