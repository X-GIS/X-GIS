# Pixel-match survey — X-GIS vs MapLibre

Labels + icons hidden on both sides to isolate fill / line / outline parity.

| View | Identical | ≤8 cumul | ≤32 cumul | ≤128 cumul | >128 px |
|---|---:|---:|---:|---:|---:|
| `bright-seoul-school` | 96.89% | 97.72% | 99.28% | 100.00% | 0 |
| `bright-tokyo-z14` | 31.91% | 63.97% | 92.43% | 100.00% | 6 |
| `liberty-paris-z14` | 22.03% | 57.07% | 81.98% | 99.77% | 1025 |
| `demotiles-europe-z2` | 86.98% | 89.70% | 94.96% | 99.68% | 1435 |

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
- **Buckets**: `{"eq0":143532,"le8":144237,"le16":75630,"le32":52413,"le64":27910,"le128":6128,"gt128":6}`

### liberty-paris-z14
- **Style**: `openfreemap-liberty`
- **Hash**: `#14/48.8534/2.3488`
- **Description**: OFM Liberty, Paris z=14 — interpolate-zoom heavy
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":99122,"le8":157613,"le16":57714,"le32":54351,"le64":52145,"le128":27886,"gt128":1025}`

### demotiles-europe-z2
- **Style**: `maplibre-demotiles`
- **Hash**: `#2.5/48/15`
- **Description**: MapLibre demotiles, Europe z=2 — 214-arm ADM0_A3 country palette
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":391286,"le8":12251,"le16":8907,"le32":14754,"le64":13871,"le128":7352,"gt128":1435}`