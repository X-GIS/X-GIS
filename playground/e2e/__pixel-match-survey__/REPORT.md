# Pixel-match survey — X-GIS vs MapLibre

Labels + icons hidden on both sides to isolate fill / line / outline parity.

| View | Identical | ≤8 cumul | ≤32 cumul | ≤128 cumul | >128 px |
|---|---:|---:|---:|---:|---:|
| `bright-seoul-school` | 96.89% | 97.72% | 99.28% | 100.00% | 0 |
| `bright-tokyo-z14` | 31.91% | 63.97% | 92.43% | 100.00% | 6 |
| `liberty-paris-z14` | 21.82% | 55.85% | 81.03% | 99.81% | 869 |
| `demotiles-europe-z2` | 86.71% | 89.43% | 94.63% | 99.62% | 1721 |

## View details

### bright-seoul-school
- **Style**: `openfreemap-bright`
- **Hash**: `#17.85/37.12665/126.92430`
- **Description**: OFM Bright, Seoul 행정초등학교 — P1 verification gate (school fill)
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":435869,"le8":3733,"le16":2467,"le32":4535,"le64":1680,"le128":1572,"gt128":0}`

### bright-tokyo-z14
- **Style**: `openfreemap-bright`
- **Hash**: `#14/35.6585/139.7454`
- **Description**: OFM Bright, Tokyo z=14 — landuse + water fills
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":143527,"le8":144228,"le16":75640,"le32":52419,"le64":27907,"le128":6129,"gt128":6}`

### liberty-paris-z14
- **Style**: `openfreemap-liberty`
- **Hash**: `#14/48.8534/2.3488`
- **Description**: OFM Liberty, Paris z=14 — interpolate-zoom heavy
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":98169,"le8":153088,"le16":57008,"le32":56272,"le64":58517,"le128":25933,"gt128":869}`

### demotiles-europe-z2
- **Style**: `maplibre-demotiles`
- **Hash**: `#2.5/48/15`
- **Description**: MapLibre demotiles, Europe z=2 — 214-arm ADM0_A3 country palette
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":390072,"le8":12223,"le16":8796,"le32":14604,"le64":14221,"le128":8219,"gt128":1721}`