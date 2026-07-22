# IHO S-111 (Surface Currents) — vendored reference catalogues

This directory holds the **official IHO S-111 Edition 2.0.0 Portrayal Catalogue and Feature
Catalogue**, checked in **unmodified** as the single-authority reference that the X-GIS
S-111 surface-current portrayal transcribes. It is documentation, not shipped runtime data —
no package bundles it.

## Why it's here

The X-GIS S-111 render (speed color fill + the direction arrow field) must be
**verifiable-by-construction** against the official spec, not "colors and rules copied from
memory." The code that transcribes this catalogue points back here:

- `map/src/color-ramp.ts` → `BANDED_RAMPS['s111-speed']` — the 9 speed-band colours, verbatim
  from `portrayal/XSLT/Symbols/SVGStyle_S111day.css` (`fSCBN1..9`) and
  `portrayal/XSLT/ColorProfiles/colorProfile.xml` (`SCBN1..9`).
- `map/src/render/s111-portrayal.ts` — the arrow rule (band thresholds, per-band scale,
  rotation, "no symbol for speed 0 / noData"), verbatim from
  `portrayal/XSLT/Rules/select_arrow.xsl` and `portrayal/XSLT/Rules/main.xsl`.

## The rule, distilled (see `portrayal/XSLT/Rules/select_arrow.xsl` for the authority)

One arrow symbol per grid point (`coverageFill`, `placement: directPosition`), colored by the
speed band, rotated by `surfaceCurrentDirection` (GeographicCRS, true-north clockwise):

| Band | Speed (knots) | Symbol   | Colour (`SCBN`) | Scale          |
| ---: | ------------- | -------- | --------------- | -------------- |
|    1 | [0, 0.5)      | SCAROW01 | `#7652E2`       | 0.40 (floor)   |
|    2 | [0.5, 1)      | SCAROW02 | `#4898D3`       | 0.40           |
|    3 | [1, 2)        | SCAROW03 | `#61CBE5`       | 0.40           |
|    4 | [2, 3)        | SCAROW04 | `#6DBC45`       | speed × 0.20   |
|    5 | [3, 5)        | SCAROW05 | `#B4DC00`       | speed × 0.20   |
|    6 | [5, 7)        | SCAROW06 | `#CDC100`       | speed × 0.20   |
|    7 | [7, 10)       | SCAROW07 | `#F8A718`       | speed × 0.20   |
|    8 | [10, 13)      | SCAROW08 | `#F7A29D`       | speed × 0.20   |
|    9 | [13, ∞)       | SCAROW09 | `#FF1E1E`       | 2.60 (ceiling) |

The 9 `SCAROW0N.svg` symbols are geometrically identical (one arrow, shaft + head, 6×11 mm,
pivot 0,0); only the fill colour differs, plus a black outline (`sCHBLK`, 0.32 mm).
`main.xsl` note (4): **speed = 0 and noData get no symbol.**

## Provenance & attribution

- **Source:** distributed by NOAA as part of the S-111 Open-Data product (the same
  `noaa-s111-pds` distribution X-GIS streams from). Retrieved 2026-07-22.
- **Versions:** Portrayal Catalogue 2.0.0, build 20240801 (updated by Portolan Sciences LLC
  for S-111 Ed. 2.0.0, based on S-100 Ed. 5.2.0); Feature Catalogue 2.0.0. The `SCAROW0N.svg`
  metadata records publisher NOAA, creationDate 2024-07-29, format S100SVG.
- **Copyright:** these are official IHO / NOAA standards artifacts, © IHO and NOAA. They are
  redistributed here **unmodified**, for reference and interoperability. The X-GIS MIT license
  (repo root `LICENSE`) covers X-GIS's own source only; these vendored files retain their
  original authorship and terms.
- **Omitted:** the outer S-100 exchange-set signature wrappers (`CATALOG.XML`, `CATALOG.SIGN`)
  from the original distribution are not included — only the catalogue content itself.

## Contents

```
111_Feature_Catalogue_2.0.0.xml        # S-111 feature/attribute definitions (uom, fill, ...)
portrayal/XSLT/
  portrayal_catalogue.xml              # catalogue index (viewing groups, symbols)
  Rules/main.xsl                       # entry rule (note (4): no symbol for speed 0 / noData)
  Rules/SurfaceCurrent.xsl             # SurfaceCurrent → select_arrow
  Rules/select_arrow.xsl               # THE arrow rule: bands → symbol / colour / scale / rotation
  Symbols/SCAROW01..09.svg             # the 9 band arrow symbols
  Symbols/SVGStyle_S111{day,dusk,night}.css   # per-palette band colours
  ColorProfiles/colorProfile.xml       # CIE + sRGB for CHBLK + SCBN1..9
```
