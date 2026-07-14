// ═══ X-GIS language version — single authority (#1064) ═══

/** The X-GIS language MAJOR version this compiler implements.
 *
 *  Every `.xgis` source MUST open with the version pragma `xgis <major>`
 *  (comments and blank lines may precede it — the lexer strips them, so
 *  the pragma need only be the first *token*). The parser gates on this
 *  constant:
 *    - a missing / malformed pragma is a hard parse error (X-GIS0008);
 *    - a MAJOR greater than this constant is a hard parse error
 *      (X-GIS0009, "written for a newer X-GIS") rather than a silent
 *      mis-parse.
 *  `convertMapboxStyle` emits `xgis <major>` as the first line of its
 *  output so imported Mapbox styles round-trip back through that gate.
 *
 *  This is the ONE source of truth for the language version — the parser
 *  gate, the converter emitter, and the corpus migration
 *  (`scripts/migrate-xgis-pragma.ts`) all read it. Bump it ONLY for a
 *  breaking language change, together with a migration of the in-repo
 *  corpus + fixtures.
 *
 *  The pragma is MAJOR-ONLY (a bare integer), mirroring Mapbox's
 *  top-level `"version": 8`: minor/patch levels are deliberately not
 *  part of the surface — a non-breaking change never needs a file to
 *  re-declare its version, and a breaking one bumps the major. */
export const XGIS_LANGUAGE_MAJOR = 1
