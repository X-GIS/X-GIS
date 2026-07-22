# NOAA data on the globe — live-load recipes (#1271 / #1272)

How to get NOAA-published data onto an `XGISMap`, in order of "how much code you
own." The render side is the same for all of them: an S-100 gridded field (S-102
bathymetry, S-111 currents) is **read in place from the HDF5 the data already lives
in** — `readCoverageFromHdf5(bytes)` yields a `CoverageHandle` directly, which the
runtime draws as a colour ramp and, for a vector field, a particle overlay. There is
**no house format** — no transcode step, no `.xgcov` blob. HDF5 (an IHO S-100 / ISO
standard) IS the wire format; the browser fetches the `.h5` bytes and reads them, the
same way a `pmtiles://` source reads PMTiles or a raster source reads a PNG tile.
This is the ADR-0010 decision — read the standard in place, never invent a container
for data that already has one (`docs/adr/0010-read-gridded-standards-in-place.md`).

> **CORS reality (verified 2026-07-21).** NOAA's gridded archives are **not**
> loadable browser-direct:
>
> | Endpoint                                             | CORS       | Usable from a browser?  |
> | ---------------------------------------------------- | ---------- | ----------------------- |
> | `api.tidesandcurrents.noaa.gov` (CO-OPS JSON)        | `*`        | ✅ direct               |
> | `api.weather.gov` (alerts GeoJSON)                   | `*`        | ✅ direct               |
> | `noaa-s111-pds` / `noaa-s102-pds` S3 (HDF5)          | none       | ❌ needs a proxy/mirror |
> | `opendap.co-ops.nos.noaa.gov` (THREDDS, HDF5/NetCDF) | none       | ❌ needs a proxy/mirror |
> | `nowcoast.noaa.gov` GeoServer WMS                    | 405 on GET | ❌ needs a tile adapter |
>
> So a gridded HDF5 product (S-102/S-111) reaches the browser through a **CORS
> proxy or mirror you host** — but note what crosses that proxy: the **same `.h5`
> bytes**, re-served with a header. There is no conversion. The question is only
> _where the CORS header is added_.

---

## Handling CORS

The one fact that unlocks all of this: **CORS is enforced by the browser, not the
server.** A server-to-server `fetch` has no CORS — so any origin **you** control can
fetch NOAA's archives freely and re-serve the bytes with an
`Access-Control-Allow-Origin` header. The fix is never "make NOAA send CORS"; it is
always "put a proxy or mirror you control between the browser and NOAA." Because the
browser reads the HDF5 in place, that proxy is a **pure passthrough** — it adds a
header, it does not touch the bytes.

**Where you host it decides where the header goes:**

| Host                                                    | Set the header via                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A mirror bucket / CDN (S3+CloudFront, R2)               | the bucket/CDN **CORS policy** (`AllowedOrigins`) — you `aws s3 cp` NOAA's cell into your bucket server-side                                                                               |
| An edge function (Cloudflare Workers, Vercel/Deno Edge) | the `Response` headers you return                                                                                                                                                          |
| A small server (nginx / Bun / Node)                     | `add_header access-control-allow-origin` / response headers                                                                                                                                |
| **Local dev**                                           | a **dev-server proxy** — `playground/vite.config` already does this for third-party tiles (`/pmtiles-proxy/protomaps`); the browser talks to localhost, so there is no cross-origin at all |

**Minimal edge function (pure CORS proxy, ~8 lines):**

```ts
// Server-side fetch: no CORS wall here. Stream NOAA's HDF5 straight through with a
// CORS header — no conversion; the browser reads the .h5 in place.
export default async function (_req: Request): Promise<Response> {
  const upstream = await fetch('https://noaa-s111-pds.s3.amazonaws.com/.../currents.h5')
  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/x-hdf5',
      'access-control-allow-origin': '*', // ← the one line the browser needs
      'cache-control': 'max-age=300', // currents refresh every ~6 min
    },
  })
}
```

The browser then points a `type: coverage` source's `url` at this edge — it only
ever talks to your origin, never NOAA.

**Live in the playground (`s111_live` demo).** The playground ships this end to end
against the REAL bucket. In dev the vite server is the proxy — `playground/dev/
noaa-s111-proxy.ts` bridges `/noaa-s111/*` to `noaa-s111-pds` with a CORS header, the
same locus as the `/pmtiles-proxy` entry. In prod the hosted static site has no server,
so `loader.ts` rewrites `/noaa-s111/` to a Cloudflare Worker (`playground/dev/
noaa-s111-worker.ts`) that serves the identical resolve+stream contract. One wrinkle the
minimal proxy above skips: the NOAA bucket is a **rolling window** (old forecast cycles
age out), so a hard-coded cell URL 404s within days. The path `/noaa-s111/latest.h5`
therefore RESOLVES the newest CBOFS cell on each request (`resolveLatestCbofsKey` walks
the date tree newest-first) — the demo's `.xgis` names that stable path and never rots:

```
source currents { type: coverage, url: "/noaa-s111/latest.h5" }
layer speed { source: currents; ramp: "viridis"; range: [0, 2] | opacity-70 }
```

**When you do NOT need any of this:** CORS-open products — CO-OPS currents
(`api.tidesandcurrents.noaa.gov`) and weather.gov alerts — already send
`access-control-allow-origin: *`, so fetch them straight from the browser (Recipe
3, the `coops_currents` demo). Only the gridded HDF5 archives need the proxy above.

**Avoid:** public CORS proxies (cors-anywhere and friends — insecure, rate-limited,
unreliable in production) and asking users to disable browser CORS (not a
deployable option).

---

## Recipe 1 — CORS-proxy the HDF5, browser reads it in place (recommended for shared data)

Put a CORS proxy or mirror in front of NOAA's cell (above), point a `type: coverage`
source at it, and you are done. The browser fetches the `.h5` and reads it in place —
no server render step, no conversion, no house format to keep in sync.

**Browser (declare the source, done):**

```
source currents {
  type: coverage
  url: "https://my-cdn/noaa/currents-latest.h5"
  ramp: "viridis"
  range: [0, 2]
}
layer speed { source: currents }
```

The `coverage` source fetches the `.h5` (through the same SSRF guard + body cap as the
geojson source), reads it with `readCoverageFromHdf5`, and stores the `CoverageHandle`
— `map.getCoverage('currents')?.valueAt(lon, lat)` then returns the exact cell value.
To refresh without a reload, re-fetch and host-push (Recipe 2's `setCoverageData`).

> **Scaling.** Today the reader loads a whole cell — right-sized for one S-111 /
> S-102 cell (a few MB for a regional forecast). You never download the whole
> archive: you fetch the one cell for your area + time, exactly as a PMTiles source
> fetches only the tiles in view. Streaming a _large_ single HDF5 (or an XYZ
> coverage pyramid) with HTTP **range requests** — the PMTiles model applied to
> HDF5 chunks — is the ADR-0010 follow-up, not needed for the per-cell case here.

---

## Recipe 2 — your own HDF5 copy + in-app live refresh (`setCoverageData`)

If you mirror the raw HDF5 on your own origin (again: NOAA's S3 is CORS-blocked, so
this must be _your_ bucket or proxy), you can swap fresh data into a declared source
without a reload — the coverage sibling of `setSourceData`. Fetch the `.h5` bytes and
hand them to the map; it reads them in place and re-arms the ramp.

```ts
// Declare `source currents { type: coverage, url: … }` in the scene first (its initial
// cell), then refresh on the forecast cadence:
async function refreshCurrents(): Promise<void> {
  const h5 = await (await fetch('https://my-bucket/noaa/currents-latest.h5')).arrayBuffer()
  await map.setCoverageData('currents', h5) // read in place → swap handle → re-arm ramp
}
setInterval(refreshCurrents, 6 * 60_000) // S-111 nowcast updates every ~6 min
```

`setCoverageData(id, hdf5Bytes, opts?)` reads the HDF5 to a fresh `CoverageHandle`,
replaces the CPU-resident one (so `getCoverage(id).valueAt(lon, lat)` reflects the new
data at once), and re-arms the GPU ramp. `ramp` / `range` default to the source's
declared (or last-pushed) palette; pass `opts` to change them.

For one cell the in-place read is sub-frame. If you load _many_ cells and the parse
becomes visible on the main thread, move the fetch into a Web Worker and hand the
transferable `.h5` `ArrayBuffer` back to `setCoverageData` — and, for large mosaics,
graduate to the range-streaming reader (the ADR-0010 follow-up noted in Recipe 1).

---

## Recipe 3 — live JSON, browser-direct (no gridded data, no proxy)

Some NOAA products are point observations served as CORS-open JSON — no grid, no
HDF5, no proxy. Fetch them straight and draw retained graphics. The **CO-OPS
live-currents demo** (`playground/src/examples/coops-currents.xgis` + the runner's
`setupCoopsOverlay`) does exactly this: it fetches the latest observed current for the
Chesapeake Bay PORTS stations from `api.tidesandcurrents.noaa.gov` and draws one arrow
per station (bearing = flow direction, length + colour = speed), refreshing every 6
minutes.

```ts
const url =
  `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest` +
  `&station=cb0102&product=currents&units=metric&time_zone=gmt&format=json`
const { data } = await (await fetch(url)).json() // CORS `*`
const { s: speed, d: dir } = data[0] // cm/s, degrees true
map.graphics.add({
  type: 'arrow',
  data: stations,
  getPosition: (st) => [st.lon, st.lat],
  getBearing: (st) => st.dir,
  getSize: (st) => 10 + Math.sqrt(st.speed) * 4,
  getColor: (st) => speedRamp(st.speed),
})
```

Use this when the product is genuinely discrete (station observations, alert
polygons). For a continuous field, use Recipe 1 or 2 — density/ramp encodes a
field honestly, discrete arrows do not.

---

## Which recipe?

| You have…                                                       | Use                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| A gridded HDF5 product (S-102/S-111) shared across many clients | **Recipe 1** (CORS-proxy the `.h5`, browser reads in place) |
| A gridded HDF5 copy you mirror, want in-app live refresh        | **Recipe 2** (`setCoverageData` on a timer)                 |
| A CORS-open JSON point/vector product                           | **Recipe 3** (fetch + `map.graphics`)                       |

Track status: S-111 surface currents (this PR) exercises Recipes 1–3, and the
`s111_live` demo runs Recipe 1 against the LIVE NOAA bucket end to end (the vite
`/noaa-s111` proxy in dev; the bundled Cloudflare Worker in prod). GFS global wind
(GRIB2) and OISST (NetCDF) are #1273 / #1274 — same render side, a new reader each
(read in place, like HDF5; no conversion). GRIB2/NetCDF decode is the missing piece
there; the HDF5 reader is the close cousin the S-100 track already built.
