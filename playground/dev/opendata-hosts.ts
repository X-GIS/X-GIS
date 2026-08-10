// ═══ Which origins the bridge may reach ═══
//
// `/opendata/<host>/<path>` can name any host in the world, so this set is the only thing
// between the bridge and being an open proxy — one anyone could borrow to launder bandwidth
// through the x-gis account. It comes from two places, on purpose:
//
//   • AWS Open Data — GENERATED from awslabs/open-data-registry (955 hosts, and growing without
//     anyone here touching it). See scripts/gen-opendata-hosts.ts.
//   • Everything else — the hand list below.
//
// The hand list is hand-maintained and that is not a defect to hide: there is no global registry
// of the world's open data. Seoul's portal, data.go.kr, an EU or Japanese agency — nobody
// publishes a machine-readable index of all of them, so somebody has to say which ones this
// bridge serves. What matters is that saying so is ONE line in ONE file, and that the two halves
// merge into ONE set with ONE lookup: adding a Korean city portal is the same edit as adding an
// AWS bucket, and neither needs a new route, a new worker, or a code change.
//
// EXACT MATCH ONLY, never a prefix or suffix rule. `noaa-s111-pds.s3.us-east-1.amazonaws.com.evil.com`
// is a registerable domain, and a `startsWith`/`endsWith` check would have handed it the
// x-gis origin's CORS grant. `opendata-bridge.test.ts` pins that.

import { AWS_OPEN_DATA_HOSTS } from './opendata-hosts.generated'

/** Non-AWS open-data origins. Add a host here to make it reachable; nothing else changes.
 *
 *  Empty today — every source the demos stream is an AWS Open Data bucket, so every host they
 *  need comes from the generated half. The list exists because the next source will not be. */
export const EXTRA_OPEN_DATA_HOSTS: readonly string[] = [
  // 'data.seoul.go.kr',
]

/** Every origin the bridge will proxy — the generated AWS half plus the hand list above. */
export const OPEN_DATA_HOSTS: ReadonlySet<string> = new Set([
  ...AWS_OPEN_DATA_HOSTS,
  ...EXTRA_OPEN_DATA_HOSTS,
])
