# Pixel-match survey — X-GIS vs MapLibre

Labels + icons hidden on both sides to isolate fill / line / outline parity.

| View | Identical | ≤8 cumul | ≤32 cumul | ≤128 cumul | >128 px |
|---|---:|---:|---:|---:|---:|
| `bright-seoul-school` | 76.48% | 77.43% | 98.87% | 100.00% | 0 |
| `bright-tokyo-z14` | 31.32% | 63.74% | 92.41% | 100.00% | 5 |
| `liberty-paris-z14` | 22.27% | 65.36% | 86.07% | 99.93% | 306 |
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
- **Buckets**: `{"eq0":140875,"le8":145882,"le16":76099,"le32":52867,"le64":27988,"le128":6140,"gt128":5}`

### liberty-paris-z14
- **Style**: `openfreemap-liberty`
- **Hash**: `#14/48.8534/2.3488`
- **Description**: OFM Liberty, Paris z=14 — interpolate-zoom heavy
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":100167,"le8":193881,"le16":40708,"le32":52441,"le64":42163,"le128":20190,"gt128":306}`

### demotiles-europe-z2
- **Style**: `maplibre-demotiles`
- **Hash**: `#2.5/48/15`
- **Description**: MapLibre demotiles, Europe z=2 — 214-arm ADM0_A3 country palette
- **Canvas**: 639×704 (449856 px)
- **Buckets**: `{"eq0":394566,"le8":8763,"le16":8885,"le32":14694,"le64":13915,"le128":7599,"gt128":1434}`