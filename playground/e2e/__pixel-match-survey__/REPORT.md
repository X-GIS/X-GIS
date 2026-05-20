# Pixel-match survey — X-GIS vs MapLibre

Labels + icons hidden on both sides to isolate fill / line / outline parity.

| View | Identical | ≤8 cumul | ≤32 cumul | ≤128 cumul | >128 px |
|---|---:|---:|---:|---:|---:|
| `bright-seoul-school` | 76.48% | 77.43% | 98.87% | 100.00% | 0 |
| `bright-tokyo-z14` | 31.31% | 63.74% | 92.44% | 100.00% | 6 |
| `liberty-paris-z14` | 22.22% | 65.33% | 86.03% | 99.93% | 300 |
| `demotiles-europe-z2` | 87.71% | 89.66% | 94.90% | 99.68% | 1434 |

## View details

### bright-seoul-school
- **Style**: `openfreemap-bright`
- **Hash**: `#17.85/37.12665/126.92430`
- **Description**: OFM Bright, Seoul 행정초등학교 — P1 verification gate (school fill)
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":344068,"le8":4242,"le16":1884,"le32":94582,"le64":3508,"le128":1572,"gt128":0}`

### bright-tokyo-z14
- **Style**: `openfreemap-bright`
- **Hash**: `#14/35.6585/139.7454`
- **Description**: OFM Bright, Tokyo z=14 — landuse + water fills
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":140870,"le8":145875,"le16":76154,"le32":52934,"le64":27940,"le128":6077,"gt128":6}`

### liberty-paris-z14
- **Style**: `openfreemap-liberty`
- **Hash**: `#14/48.8534/2.3488`
- **Description**: OFM Liberty, Paris z=14 — interpolate-zoom heavy
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":99971,"le8":193914,"le16":40891,"le32":52240,"le64":42267,"le128":20273,"gt128":300}`

### demotiles-europe-z2
- **Style**: `maplibre-demotiles`
- **Hash**: `#2.5/48/15`
- **Description**: MapLibre demotiles, Europe z=2 — 214-arm ADM0_A3 country palette
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":394566,"le8":8763,"le16":8885,"le32":14694,"le64":13915,"le128":7599,"gt128":1434}`