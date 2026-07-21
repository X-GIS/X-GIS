# NOAA data on the globe — live-load recipes (#1271 / #1272)

How to get NOAA-published data onto an `XGISMap`, in order of "how much code you
own." The render side is the same for all of them: an S-100 gridded field becomes
a `.xgcov` coverage (compact, self-describing, `~200`-line zero-dep decode) that
the runtime draws as a colour ramp and — for a vector field — a particle overlay.
`.xgcov` is the **serialization boundary**, not a storage quirk: every real path
crosses either a network boundary (server → browser) or a thread boundary (worker
→ main), and both need bytes. A `CoverageHandle` has methods, so it cannot cross
either; the `.xgcov` bytes can.

> **CORS reality (verified 2026-07-21).** NOAA's gridded archives are **not**
> loadable browser-direct:
>
> | Endpoint                                             | CORS       | Usable from a browser?  |
> | ---------------------------------------------------- | ---------- | ----------------------- |
> | `api.tidesandcurrents.noaa.gov` (CO-OPS JSON)        | `*`        | ✅ direct               |
> | `api.weather.gov` (alerts GeoJSON)                   | `*`        | ✅ direct               |
> | `opendap.co-ops.nos.noaa.gov` (THREDDS, HDF5/NetCDF) | none       | ❌ needs a proxy/copy   |
> | `nowcoast.noaa.gov` GeoServer WMS                    | 405 on GET | ❌ needs a tile adapter |
>
> So a gridded product (S-102/S-111 HDF5, GFS GRIB2, OISST NetCDF) **always** goes
> through a conversion step you host — there is no "fetch the `.h5` from NOAA in
> the browser" path. The question is only _where_ the conversion runs.

---

## Handling CORS

The one fact that unlocks all of this: **CORS is enforced by the browser, not the
server.** A server-to-server `fetch` has no CORS — so any origin **you** control
can fetch NOAA's archives freely and re-serve them with an
`Access-Control-Allow-Origin` header. The fix is never "make NOAA send CORS"; it is
always "put a server or CDN you control between the browser and NOAA."

**Where you host it decides where the header goes:**

| Host                                                    | Set the header via                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Static `.xgcov` on a CDN / bucket (S3+CloudFront, R2)   | the bucket/CDN **CORS policy** (`AllowedOrigins`)                                                                                                                                          |
| An edge function (Cloudflare Workers, Vercel/Deno Edge) | the `Response` headers you return                                                                                                                                                          |
| A small server (nginx / Bun / Node)                     | `add_header access-control-allow-origin` / response headers                                                                                                                                |
| **Local dev**                                           | a **dev-server proxy** — `playground/vite.config` already does this for third-party tiles (`/pmtiles-proxy/protomaps`); the browser talks to localhost, so there is no cross-origin at all |

**Minimal edge function (proxy + convert, ~10 lines):**

```ts
import { s100ToXgcov } from '@xgis/pipeline/hdf5'

// Server-side fetch: no CORS wall here. Convert, then hand the browser bytes it
// IS allowed to read.
export default async function (_req: Request): Promise<Response> {
  const h5 = await (await fetch('https://noaa-thredds/.../currents.h5')).arrayBuffer()
  const { buffer } = await s100ToXgcov(h5, { quantize: 'u16' })
  return new Response(buffer, {
    headers: {
      'content-type': 'application/octet-stream',
      'access-control-allow-origin': '*', // ← the one line the browser needs
      'cache-control': 'max-age=300', // currents refresh every ~6 min
    },
  })
}
```

The browser then points a `type: coverage` source's `url` at this edge — it only
ever talks to your origin, never NOAA.

**When you do NOT need any of this:** CORS-open products — CO-OPS currents
(`api.tidesandcurrents.noaa.gov`) and weather.gov alerts — already send
`access-control-allow-origin: *`, so fetch them straight from the browser (Recipe
3, the `coops_currents` demo). Only the gridded archives (HDF5 / GRIB2 / NetCDF)
need the proxy above.

**Avoid:** public CORS proxies (cors-anywhere and friends — insecure, rate-limited,
unreliable in production) and asking users to disable browser CORS (not a
deployable option).

---

## Recipe 1 — server converts, browser fetches `.xgcov` (recommended for shared data)

Convert once on a server (cron / edge function / build step), serve the `.xgcov`
with CORS + a cache header, and every client just fetches + decodes it. The heavy
HDF5/GRIB reader never ships to the browser.

**Server (Bun cron / edge function, ~20 lines):**

```ts
import { s100ToXgcov } from '@xgis/pipeline/hdf5'
import { writeFileSync } from 'node:fs'

// Fetch YOUR mirror of the cell (you copied it from NOAA's THREDDS server-side,
// where there is no CORS wall). Then convert and publish.
const h5 = await (await fetch('https://my-bucket/noaa/currents-latest.h5')).arrayBuffer()
const { buffer, product, bandNames } = await s100ToXgcov(h5, { quantize: 'u16' })
writeFileSync('/srv/static/currents-latest.xgcov', Buffer.from(buffer))
console.log(`published ${product}: ${bandNames.join(', ')}`)
// serve /srv/static/*.xgcov with `access-control-allow-origin: *`
// and e.g. `cache-control: max-age=300` (currents update every 6 min)
```

**Browser (declare the source, done):**

```
source currents {
  type: coverage
  url: "https://my-cdn/currents-latest.xgcov"
  ramp: "viridis"
  range: [0, 2]
}
layer speed { source: currents }
```

To refresh without a reload, re-fetch and host-push (see Recipe 2's `setCoverageData`).

---

## Recipe 2 — browser worker converts your own copy (no server render step)

If you can serve the raw HDF5 from your own origin (again: NOAA's THREDDS is
CORS-blocked, so this must be _your_ bucket), convert it in a Web Worker so the
HDF5 parse never blocks the UI, and hand the `.xgcov` bytes to the map. The
`.xgcov` `ArrayBuffer` is **transferable**, so crossing the worker→main boundary
is zero-copy — this is exactly the boundary `.xgcov` exists for.

**worker.ts:**

```ts
import { s100ToXgcov } from '@xgis/pipeline/hdf5'

self.onmessage = async (e: MessageEvent<{ url: string }>) => {
  const h5 = await (await fetch(e.data.url)).arrayBuffer()
  const { buffer } = await s100ToXgcov(h5) // reader → north-up flip → encode
  postMessage(buffer, [buffer]) // transfer, no copy
}
```

**main thread:**

```ts
// Declare the coverage source in the scene first (a small placeholder .xgcov
// url, or your bucket's initial cell), then swap fresh data in:
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
worker.postMessage({ url: 'https://my-bucket/noaa/currents-latest.h5' })
worker.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  map.setCoverageData('currents', e.data) // decode + re-arm the ramp, no reload
}
```

`setCoverageData(id, xgcovBytes, opts?)` replaces the CPU-resident
`CoverageHandle` (so `getCoverage(id).valueAt(lon, lat)` reflects the new data at
once) and re-arms the GPU ramp. `ramp` / `range` default to the source's declared
palette; pass `opts` to change them.

---

## Recipe 3 — live JSON, browser-direct (no gridded data, no conversion)

Some NOAA products are point observations served as CORS-open JSON — no grid, no
`.xgcov`, no server. Fetch them straight and draw retained graphics. The
**CO-OPS live-currents demo** (`playground/src/examples/coops-currents.xgis` +
the runner's `setupCoopsOverlay`) does exactly this: it fetches the latest
observed current for the Chesapeake Bay PORTS stations from
`api.tidesandcurrents.noaa.gov` and draws one arrow per station (bearing = flow
direction, length + colour = speed), refreshing every 6 minutes.

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

| You have…                                                              | Use                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| A gridded product (HDF5 / GRIB2 / NetCDF) shared across many clients   | **Recipe 1** (server convert, CDN the `.xgcov`)   |
| A gridded product you can mirror, single client, want no render server | **Recipe 2** (worker convert → `setCoverageData`) |
| A CORS-open JSON point/vector product                                  | **Recipe 3** (fetch + `map.graphics`)             |

Track status: S-111 surface currents (this PR) exercises Recipes 1–3. GFS global
wind (GRIB2) and OISST (NetCDF) are #1273 / #1274 — same render side, a new reader
each. GRIB2/NetCDF decode is the missing piece there; the HDF5 reader is the
close cousin the S-100 track already built.
