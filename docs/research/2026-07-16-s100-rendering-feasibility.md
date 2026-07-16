# S-100 Rendering-Feasibility Report for X-GIS

**Prepared:** 2026-07-15 · **Basis:** Cross-verified IHO/NOAA/GDAL/academic findings only · **Subject engine:** X-GIS (WebGPU 3D globe/map engine, direct vector reprojection + subdivision, normalized-sphere globe basis, known ~21.5 km sphere-vs-ellipsoid offset)

Every factual claim below carries an inline source URL + document edition. Claims that did **not** clear the cross-verification bar are marked `[UNVERIFIED]` inline and are additionally consolidated in §7. Nothing in §1–§5 is asserted from memory; §6 (X-GIS FIT) is explicitly engineering analysis built _on top of_ the verified facts and is labelled as such.

---

## 1. S-100 framework & parts

### 1.1 What S-100 is

S-100 is a **framework standard, not a product**. It "provides a theoretical framework of components that are based on the ISO 19100 series of standards" and "comprises a set of related parts that give the user the appropriate tools and framework… users will be able to build constituent parts of an S-100 compliant product specification" (S-100 Ed 5.2.0, June 2024, Introduction p.vi / Scope 0-1 p.1 — https://iho.int/uploads/user/pubs/standards/s-100/S-100_5.2.0_Final_Clean.pdf). Independently, NOAA calls it "a multi-part model based framework" (NOAA Marine Navigation developer page, accessed 2026-07-16 — https://marinenavigation.noaa.gov/developer.html), and a peer-reviewed academic source states "the S100 standard is the base standard, and each hydrographic information is developed as a document called the product specification" (TransNav 17(2) 2023, Lee & Kim, KMOU — https://www.transnav.eu/files/IHO_S100_Data_Model_and_Relevant_Product_Specification,1399.pdf).

It is the **successor to S-57** ("S-100 will eventually replace S-57") and is documented in **UML** — only class, object and package diagrams are used (S-100 Ed 5.2.0, Introduction p.vi; §0-4.2). It conforms to the ISO/TC211 series "as far as is reasonably possible… tailored to suit hydrographic requirements" and is "closely aligned with… the Open Geospatial Consortium (OGC)" (S-100 Ed 5.2.0, Scope 0-1 / Introduction p.vi).

### 1.2 The parts (Table 0-1, Ed 5.2.0)

The 26-entry enumeration below is verified verbatim against the Ed 5.2.0 primary (ToC 0-4.2→0-4.26 + Table 0-1 body pp.3-4 + per-part descriptive sections agree internally; NOAA partially corroborates Parts 9/10/15) — https://iho.int/uploads/user/pubs/standards/s-100/S-100_5.2.0_Final_Clean.pdf:

| Part                 | Title                                                      | ISO base standard profiled                                             |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1                    | Conceptual Schema Language                                 | ISO 19103:2005                                                         |
| 2 / 2a / 2b          | Registers / Concept & Data Dictionary / Portrayal Register | ISO 19135:2005                                                         |
| 3                    | General Feature Model & Rules for Application Schema       | ISO 19109                                                              |
| 4a / 4b / 4c         | Metadata / Imagery-Gridded / Data Quality                  | ISO 19115-1:2014(+Amd1:2018), 19115-2:2009, 19157 (+19113/19114/19138) |
| 5                    | Feature Catalogue                                          | ISO 19110:2005                                                         |
| 6                    | Coordinate Reference Systems                               | ISO 19111:2007                                                         |
| 7                    | Spatial Schema                                             | ISO 19107:2003 (reduced subset)                                        |
| 8                    | Imagery & Gridded Data                                     | ISO 19129 (+19123:2007)                                                |
| 9 / 9a               | Portrayal / Portrayal (Lua)                                | ISO 19117:2012                                                         |
| 10 / 10a / 10b / 10c | Encoding Formats / ISO-8211 / GML / HDF5                   | ISO/IEC 8211:1994 / ISO 19136:2007 / HDF5                              |
| 11                   | Product Specifications                                     | ISO 19131:2008                                                         |
| 12                   | Maintenance                                                | —                                                                      |
| 13                   | Scripting                                                  | —                                                                      |
| 14                   | Online Communication Exchange                              | —                                                                      |
| 15                   | Encryption / Data Protection                               | —                                                                      |
| 16 / 16a             | Interoperability Catalogue / Harmonised Portrayal          | —                                                                      |
| 17                   | Discovery Metadata                                         | —                                                                      |
| 18                   | Language Packs                                             | —                                                                      |

(ISO mappings verified from per-part descriptive text §0-4.x; note the standard's _own_ table/text divergence on Part 4 quality — §0-4.7 lists ISO 19113/19114/19157 while Table 0-1 lists ISO 19138.)

### 1.3 Key framework components a renderer touches

- **General Feature Model (Part 3):** "a conceptual model for features, their characteristics and associations… a profile of the GFM presented in ISO 19109" and "a fundamental element of any S-100 based product specification" (S-100 Ed 5.2.0 §0-4.6).
- **GI Registry (Part 2):** hosts the Concept Register (stores "stateless" concepts), Data Dictionary Register (assigns item types + feature binding), Portrayal Register, Producer-Codes Register, Product-Spec Register, and Catalogue Builders (S-100 Ed 5.2.0, Introduction p.vi / §0-4.4). Live endpoints (registry.iho.int) confirmed by IHO-OHI S100Resources (accessed 2026-07-16 — https://iho-ohi.github.io/S100Resources/).
- **Feature Catalogue (Part 5):** "a document that describes the content of a data product… defined for each Product Specification," at the **type level, not individual instances**; NOAA calls it "a machine-readable representation of the application schema" and TransNav confirms it is XML-based (S-100 Ed 5.2.0 §0-4.8; NOAA developer page; TransNav 17(2) 2023).
- **Portrayal Catalogue (Part 9/9a):** "specifies the portrayal model for defining and organizing symbols and portrayal rules necessary to portray S-100 product Features"; a PC bundles an input schema, mapping rules (XSLT **or** Lua), and symbols (SVG); Part 9a (Lua) additionally requires Part 13; conforms to ISO 19117:2012 (S-100 Ed 5.2.0 §0-4.12/0-4.13, Table 0-1; NOAA developer page; TransNav 17(2) 2023).
- **Part 15 (Encryption):** secures **datasets AND** the Feature and Portrayal Catalogues, with digital signatures and key management (S-100 Ed 5.2.0 §0-4.22; near-identical wording on NOAA developer page; operational scheme corroborated by S-100WG10 report Sept 2025 — https://iho.int/uploads/default/b/r/br-2025-en-s-100wg10-v1.pdf).

### 1.4 A product specification (vs the framework)

Governed by **Part 11** ("a descriptive IHO profile of ISO 19131"), a product spec bundles: an application schema (GFM instance), a machine-readable Feature Catalogue, a Portrayal Catalogue, an encoding, and metadata. NOAA: "S-100 provides the framework for product specifications which define the data product but also includes… machine readable feature catalogue and portrayal catalogue" (NOAA S-100 page, accessed 2026-07-16 — https://marinenavigation.noaa.gov/s100.html; S-100 Ed 5.2.0 §0-4.18; TransNav 17(2) 2023).

### 1.5 Current editions & operational status (CONFIRMED)

- **Framework:** S-100 **Ed 5.2.1 (December 2025)** is the latest published edition (a clarifications/maintenance edition — no new Parts); **Ed 5.2.0** was June 2024 (IHO standards page, accessed 2026-07-16 — https://iho.int/en/standards-and-specifications). S-100WG10 (Bali, Sept 2025) "reviewed 27 change proposals… approved 24 proposals as clarifications for inclusion in S-100 Edition 5.2.1… The remaining three… primarily considered to be extensions… reconsidered in the next full revision cycle" (S-100WG10 report — https://iho.int/uploads/default/b/r/br-2025-en-s-100wg10-v1.pdf). _("No new Parts" is a sound inference from "clarification edition" + the three deferred proposals being extensions; the report does not itemize part-level diffs.)_
- **Phase-1 product specs (in force January 2026):** S-101 ENC Ed 2.0.0, S-102 Ed 3.0.0, S-104 Ed 2.0.0, S-111 Ed 2.0.0 (all Dec 2024), plus S-124/S-128/S-129 Ed 2.0.0. Each ships matching Feature/Portrayal Catalogue editions (e.g. S-101 FC 2.0.0 / PC 2.0.0) (IHO standards page; IHO-OHI S100Resources; IHO "S-100 framework is now operational" — https://iho.int/en/the-s-100-framework-is-now-operational).

---

## 2. Encoding formats (GML vs HDF5 vs ISO 8211)

### 2.1 Format neutrality

S-100 is **format-neutral by design**: Objective 0-3(3) is "To separate the data content from the encoding format, enabling format neutral product specifications," and "S-100 does not mandate particular encoding formats" (S-100 Ed 5.2.0 §0-4.14 / Objectives — https://iho.int/uploads/user/pubs/standards/s-100/S-100_5.2.0_Final_Clean.pdf). Table 0-2 gives an explicitly "incomplete" example list — ISO/IEC 8211, GML, XML, GeoTIFF, HDF-5, JPEG2000 — but only three have dedicated Part 10 profiles. NOAA independently states products "do not specify particular encoding formats (e.g., GML, netCDF, HDF5)" (NOAA S-100 page — https://marinenavigation.noaa.gov/s100.html).

**Facet-premise correction (CONFIRMED):** all three live under **Part 10**: 10a = ISO/IEC 8211 Encoding Schema, 10b = GML Encoding, 10c = HDF5. There is **no Part 10d and no JSON encoding part** in Ed 5.2.0 (ToC jumps 10c → Part 11) — verified as absence-of-evidence for 5.2.0 only; a 5.2.1 delta is an open gap (§7).

### 2.2 Part 10a — ISO/IEC 8211 (binary, VECTOR)

A **binary** encoding based on ISO/IEC 8211:1994. It "specifies the structure of an exchange set at the record and field levels… their implementation as ISO/IEC 8211 data records, fields, and subfields… For the encoding only the binary ISO/IEC 8211 format is used" (S-100 Ed 5.2.0 §10a-4.1). It carries the S-57 lineage forward to the vector navigation specs **S-101 (ENC)** and **S-401 (Inland ENC)** — NOAA groups these under "ISO 8211 Binary" (NOAA developer page — https://marinenavigation.noaa.gov/developer.html). ⚠️ NOAA warns "the ISO 8211 profile in S-100 is different from the one contained within S-57" — same family, **not** byte-compatible.

### 2.3 Part 10b — GML (XML, VECTOR)

A **profile of GML / ISO 19136:2007** used to build GML Application Schemas carrying GFM feature/information types; a dataset is an XML file conforming to the product's GML Application Schema (S-100 Ed 5.2.0 §10b-1 / §10b-3). Its scope **explicitly excludes gridded and coverage data** (out-of-scope item 6, verbatim), plus update formats and non-GML content (feature/portrayal catalogues, exchange-set metadata). Used by vector feature-overlay specs **S-122 (Marine Protected Areas), S-412 (Weather Overlay), S-421 (Route Plan)** — NOAA "GML (Profile of ISO 19136): S-122, S-412, S-421". (S-123 Marine Radio Services GML membership is **inferred**, not in NOAA's explicit list — §7.)

### 2.4 Part 10c — HDF5 (binary container, GRIDDED)

A **profile of HDF5** "used for imagery and gridded data"; in Ed 5.2.0 it "conforms to release 1.8.8 of HDF5" (S-100 Ed 5.2.0 §10c-1 / §10c-3). A dataset is a single HDF5 file with a rooted group hierarchy: **Root group → Feature information group (Group_F) → Feature container group → Feature instance group → Data values groups**, plus Tiling/Positioning/Indexes groups (§10c-9). Used by the gridded/coverage specs **S-102 (Bathymetric Surface), S-104 (Water Level), S-111 (Surface Currents)** — NOAA "HDF5 (Gridded Data): S-102, S-104, S-111"; corroborated by Part 8 §8-12 "The standard S-100 encoding for coverage datasets is described in S-100 Part 10c."

### 2.5 The hard vector/gridded boundary

| Encoding     | Part | Nature           | Data kind                        | Product specs       |
| ------------ | ---- | ---------------- | -------------------------------- | ------------------- |
| ISO/IEC 8211 | 10a  | Binary           | **Vector** (GFM features)        | S-101, S-401        |
| GML          | 10b  | XML              | **Vector** (GFM features)        | S-122, S-412, S-421 |
| HDF5         | 10c  | Binary container | **Gridded / coverage / imagery** | S-102, S-104, S-111 |

The boundary is confirmed from three distinct primary locations (Part 10b out-of-scope item 6 "Gridded and coverage data"; Part 10c scope "imagery and gridded data"; Part 8 §8-12 encoding clause) plus NOAA's product groupings. The **same GFM** is encoded as 8211/GML for vector and as HDF5 groups for coverages. Cross-file references within an exchange set use `extObjRef:<fileName>:<recordIdentifier>` where the identifier is the `gml:id` (GML) or RCID (ISO 8211) — defined **only** for 8211/GML files, not HDF5, reinforcing the split (S-100 Ed 5.2.0, verbatim at two locations).

**Dataset vs exchange set (Part 8, verbatim):** "A dataset is an identifiable collection of data… the logical entity that can be identified by the associated discovery metadata, not the physical entity of exchange" (§8-5.3.1). "The nominal transmittal for S-100 datasets is via Exchange Sets. An Exchange Set represents the physical entity of exchange" (§8-5.3.3). The Exchange Catalogue (Part 17) is an XML machine-to-machine index over the overall catalogue, each dataset, and support files, and "can only be restricted at the Product Specification level."

---

## 3. Product specs: what rendering each requires

### 3.1 S-101 ENC — vector (ISO 8211)

**Editions/status:** S-101 Ed 2.0.0 (Dec 2024), in force 01 Jan 2026; supersedes the S-57 ENC PS (IHO S-100 Standards In Force, updated 03 Jul 2026 — https://iho.int/en/s-100-standards-in-force-0; IHO S-101→S-199 page — https://iho.int/en/iho-s-101-to-s-199). _(Note: the S-101 Ed 2.0.0 overview normatively references S-100 Version 5.2.0, while the in-force framework edition has since ratcheted to 5.2.1 — both true.)_

**Data model (what a renderer must ingest):**

- Conforms to the **GFM (Part 3)**; content is **feature types + information types**. Feature types are **geo** (principal ENC content), **meta** (info about other features; overrides default metadata), and **cartographic** (representation incl. text) (S-101 PS Ed 2.0.0 §4 — https://raw.githubusercontent.com/metanorma/iho-s-101/main/sources/2.0.0/main/sections/04-data-content.adoc; DCEG Annex A §2.1).
- Relationships modelled three ways — **Feature Association, Aggregation, Composition** (strong aggregation: deleting container deletes containees) — plus **Information Types** related via information/spatial associations, so "information [is] encoded once and related to several different features" (S-101 PS §4.3.3–§4.3.5; ECC blog 15 Jul 2022 — https://blog.ecc.no/s-101-enc-what-it-is-why-it-is-important-and-when-it-becomes-available).
- **Complex attributes** = aggregation of simple/complex attributes; OBJNAM becomes complex with a Boolean `displayName` + `name` (producer stores multiple values, controls display; full detail via pick report) — vs S-57's one-value-per-attribute (Hydro International, Powell/NOAA, 15 Oct 2014 — https://www.hydro-international.com/content/article/s-101-the-new-iho-electronic-navigational-chart-product-specification; International Hydrographic Review "Conversion of ENCs from S-57 to S-101" — https://ihr.iho.int/articles/conversion-of-electronic-navigational-charts-from-s-57-to-s-101-standard-format/). _(The specific "seven simple attribute value types" count is single-source — §7.)_

**Geometry (what a renderer must draw):**

- Constrained to **S-100 topology level 3a** — 0/1/2-D: points, curves, surfaces (abbrev P/A/C/S per DCEG Table 2-1); each spatial value must be referenced by ≥1 feature instance (S-101 PS §4.8.1; DCEG §2.3).
- Coordinates **2-D except GM_Point/GM_Multipoint** (may be 3-D, e.g. soundings). Each curve references start+end points and **must not self-intersect**; surfaces are a closed loop of curves with **outer boundary clockwise** (S-101 PS §4.8.1). Composite-curve support is real but rests on the ECC blog only (§7).
- **Masking:** curve symbolisation may be suppressed via the Masked Spatial Type `[MASK]` field (MIND subfield {1}/{2}) (S-101 PS §4.8.3).

**Encoding:** ISO/IEC 8211 + ISO 10646 BMP; strings UTF-8; CMFX/CMFY fixed 10⁷, CMFZ fixed 10 (one decimal); no leading / no non-significant trailing zeros (S-101 PS §10). Base + incremental updates in S-100 exchange sets, with base "unknown" vs update null-replacement handling (§10.1.5). Dataset scope is **Global**, S-100 maintenance level 006 ("series"), name "ENC Dataset" (§2).

**Portrayal (see §4):** Uses the S-100 model (Part 9/9a); the S-101 Portrayal Catalogue is **Lua-based**, defining symbology per feature/attribute combination with portrayal rules + pixmaps, symbols, complex line styles, area fills, fonts, colour profiles; symbols follow IHO S-4 (S-101 PS §9).

**Structural change vs S-57 that matters to a renderer:** catalogues are **externalised and machine-readable/versioned** via the IHO registry ("plug and play" updates), instead of embedded in ECDIS software (S-57 catalogue changes "may take up to five years to implement") (Hydro International 2014; S-101 PS §9; ECC blog 2022). _(The ~5-year figure is single-source.)_

### 3.2 S-102 / S-104 / S-111 — gridded (HDF5)

All three are **ISO 19123 grid coverage products** wrapped as an S-100 feature container ("a coverage exposed as a feature instance"), readable with standard HDF5 tools / h5py / GDAL (GDAL S-102/S-104/S-111 drivers — https://gdal.org/en/stable/drivers/raster/s102.html; NOAA developer page; s100py — https://raw.githubusercontent.com/noaa-ocs-s100/s100py/main/s100py/s100/v5_2/api.py).

**Shared HDF5 grid model:** `dataCodingFormat` (DCF) enum: 1=fixed stations, 2=regular grid, 3=ungeorectified grid, 4=moving platform, 5=irregular grid, 6=variable cell size, 7=TIN, 8=stationwise, **9=featureOrientedRegularGrid** (S-100 v5.2 adds value 9, used by S-102's QualityOfBathymetryCoverage) (s100py S-100 v5.2 api.py, citing Table 10c-4/10c-23). Structure: root + carrier metadata → Group_F → one feature-container group per feature → feature-instance group `<Feature>.01` (gridOrigin*, gridSpacing*, numPoints*, startSequence) → Group_001..NNN each holding a compound `values` dataset; **DCF-3 adds a Positioning group** of explicit coordinates.

| Spec                          | Ed.                  | DCF                                 | Bands / values                                                                                            | Time                                                 | Vertical ref                                                |
| ----------------------------- | -------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| **S-102 Bathymetric Surface** | 3.0.0 (Dec 2024)     | **2**                               | band1 depth, band2 uncertainty (BAG-derived, v1.4); + QualityOfBathymetryCoverage FAT (DCF 9)             | **Static** (no time dim)                             | Sounding/chart datum, **positive-down**                     |
| **S-104 Water Level**         | 2.0.0 (Dec 2024)     | **2** (s100py implements only DCF2) | band1 waterLevelHeight, band2 waterLevelTrend (0=nodata,1=dec,2=inc,3=steady), optional band3 uncertainty | **Time-series**                                      | Chart datum (NOAA: MLLW; verticalDatum=12, verticalCS=6499) |
| **S-111 Surface Currents**    | 2.0.0 (Dec 2024) IHO | **2 & 3** (GDAL reads DCF2 only)    | band1 speed (knots), band2 direction (° true, CW), optional uncertainty; currents at 4.5 m depth          | **Time-series** (Group_001..NNN, one grid/timestamp) | —                                                           |

Sources: GDAL S-102/S-104/S-111 driver pages; s100py s102/s104/s111 docs & api; NOAA developer page; NOAA S-104/S-111 PDS READMEs (https://noaa-s104-pds.s3.amazonaws.com/README.html, https://noaa-s111-pds.s3.amazonaws.com/README.html); Wikipedia BAG article (https://en.wikipedia.org/wiki/Bathymetric_attributed_grid); Marine Technology News (https://www.marinetechnologynews.com/news/member-states-adopt-operational-644362).

**What rendering these requires:**

- **S-102:** georeferenced **regular quadrilateral grid on WGS 84**; render as a raster DEM — depth band drives colour ramp / hypsometric shading / 3-D seafloor extrusion (sign must be inverted: positive = below datum). Optional per-cell uncertainty band; multi-resolution via multiple coverage instances; NOAA subsets to the OCS Nautical Product Tiling Scheme. A **tracking list** may override grid values for safety (NOAA). Time-independent — a single collocated depth+uncertainty surface.
- **S-104 / S-111:** inherently **time-series** — a renderer must animate/select by timestamp (GDAL exposes one subdataset per timestamp; time metadata numberOfTimes, timeRecordInterval, dateTimeOfFirst/LastRecord, datasetDeliveryInterval e.g. "PT6H"). Native arrays are **south-row-first** (GDAL flips to north-up by default; `NORTH_UP=NO` exposes native ordering). S-111 currents render as a vector field (speed+direction) — directly analogous to X-GIS's existing GPU flow-map / arrow primitives (see §6). NOAA S-111 is sourced from NOS Operational Forecast Systems (CBOFS ~500 m, 4 cycles/day, 48 h; Global RTOFS ~8500 m, daily, 72 h @ 6 h) (NOAA developer page; AWS Open Data registries — https://registry.opendata.aws/noaa-s111/).

---

## 4. Portrayal & symbology (Part 9 + S-52)

### 4.1 The Part 9 model — how a feature becomes a chart

Part 9 defines a **feature-centred, function-based** portrayal model: data is modelled for content only; portrayal maps content → symbols by rules/functions, so the same content can be displayed different ways without touching the data. The pipeline (Figure 9-1, verbatim) is:

**Feature Data → Portrayal Engine (portrayal functions) → Drawing Instructions → Rendering Engine (Symbol Definitions) → Portrayal Output** (S-100 Ed 5.2.0 Part 9 §9-4/9-5 — https://iho.int/uploads/user/pubs/standards/s-100/S-100_5.2.0_Final_Clean.pdf; Hexagon/Luciad ECDIS FAQ — https://dev.luciad.com/portal/productDocumentation/LuciadFusion/docs/articles/faq/ecdis/standards.html).

**Two engine mechanisms:**

- **XSLT (Part 9):** feature data exposed as XML to an XSLT processor; best-matching template/portrayal-function applied per feature; drawing instructions output as XML. **XSLT 1.0** chosen as "the most commonly supported"; user/context parameters fed in (Figure 9-2) (§9-5.1 / §9-10).
- **Lua (Part 9a):** defines "the additions and changes to S-100 Part 9 necessary to implement portrayal using the scripting mechanism defined in S-100 Part 13"; **Lua 5.1**; host provides a Lua interpreter instead of XSLT; the catalogue folder structure is unchanged, only the Rules folder's XSLT is replaced by Lua files (§0-4.13; Part 9a; Part 13 §13-7.1). Part 9a's drawing-instruction model is a **command-driven state machine** "consistent with both SVG and S-52 DAI, but differs from Part 9 which uses stateless drawing instructions" (§9a, verbatim). A viewer runs the Lua catalogue over the SENC features via entry point **`PortrayalMain`** and host callback **`HostPortrayalEmit`**, with an optional portrayal cache (Part 9a §9a-14).

### 4.2 What a renderer must implement

**Portrayal Catalogue structure (machine-readable directory, verbatim §9-13.2):** root `portrayal_catalogue.xml` (+ optional Alert Catalogue) with subfolders **Pixmaps (XML), ColorProfiles (XML), Symbols (SVG + CSS2 stylesheets), LineStyles (XML), AreaFills (XML), Fonts (TrueType), Rules (feature→drawing-instruction mapping files)**. The real S-101 PC matches exactly and is Lua-based: 217 `.lua` files, 725 `.svg` files, ~98% Lua, with S-52-style filenames (BCNGEN01, BOYPIL, DISMAR, ACHARE51, COLREG01) (S-101 Portrayal Catalogue git tree, main — https://api.github.com/repos/iho-ohi/S-101_Portrayal-Catalogue/git/trees/main?recursive=1; https://github.com/iho-ohi/S-101_Portrayal-Catalogue).

**Drawing instruction types (§9-11):** Null (intentionally not portrayed), **Point** (parameterizable symbol), **Line, Area, Text, Coverage** — each links a feature to a symbol/alert reference + geometry (from the feature or via augmented geometry).

**Display control a renderer must honour:**

- **Viewing Groups** = on/off filter (a drawing instruction with multiple viewing groups is off if **any** is off) → aggregated into Viewing Group Layers → Display Modes.
- **Display Modes** (S-101 PC, verbatim): **DisplayBase** ("Always on display"), **StandardDisplay** ("ECDIS default display"), **OtherInformation** ("All other objects in the SENC") — the classic S-52 Base/Standard/Other model expressed via S-100 viewing groups.
- **Display Planes** relative to radar: positive = above (OverRadar order 1), 0 = reserved for radar, negative = below (UnderRadar order −1).
- **Display Priorities** order rendering; ties broken **area → line → point → text** (§9-11.1.6, verbatim).

**Symbols / geometry math:**

- Symbols, line styles, area patterns are **SVG**, per the normative **S-100 SVG Profile (Appendix 9-B)** — a subset of **W3C SVG Tiny 1.2** (version fixed 1.2, baseProfile "tiny"); **y-axis points down**; each symbol carries a `viewBox` and explicit **pivot point** (§9-B; W3C SVG Tiny 1.2, 22 Dec 2008 — https://www.w3.org/TR/SVGTiny12/).
- **Colour via CSS classes** — two per token (`.sXXXXX` stroke, `.fXXXXX` fill), e.g. `.fCHYLW{fill:#E1E139}`; elements carry both a literal fallback colour and class tokens (`class="fCHYLW sCHBLK"`); CSS may be used **only** for (1) fill/stroke colour and (2) toggling engineering elements (pivot/viewbox) (§9-B-4.3/4.4, verbatim).
- **Transparency composites multiplicatively:** a 10%-transparency token drawn at 20% → (1−0.10)(1−0.20) = **72% alpha** (§9-11.1.4, verbatim).
- **Portrayal CRS:** geographic coordinates "mapped by means of projections and affine transformation to the Portrayal CRS [output-device pixels]. Nevertheless rotations of symbols may still be defined relative to the North-Axis of the Geographic CRS" (§9-11.1.2, verbatim).

### 4.3 S-52 inheritance (the colour/palette model)

The colour-token system is **inherited from S-52**: the S100SVG metadata records `iho:source="S52Preslib4.0"`, and S-52 is a normative reference ("IHO S-52… Edition 6.1.(1), October 2014") (§9-B-2.3 / Part 1 normative refs, verbatim). The S-101 `colorProfile.xml` defines three palettes **Day/Dusk/Night** keyed by S-52 tokens (e.g. CHBLK 0,0,0 / 107,127,137 / 37,45,49; DEPDW 201,237,255 / 0,0,0 / 0,0,0), each carrying both CIE xyL and sRGB — so **day/dusk/night switching is a token→RGB remap**, the S-52 palette model (S-101 Portrayal Catalogue colorProfile.xml — https://raw.githubusercontent.com/iho-ohi/S-101_Portrayal-Catalogue/main/PortrayalCatalog/ColorProfiles/colorProfile.xml). S-52's Presentation Library (colour tables, point symbols, line/fill styles, look-up tables, conditional-symbology procedures) is functionally succeeded by the S-100 machine-readable PC (SVG + Lua) rather than the S-57/S-52 lookup-table + DAI vector form (IHO ENC Portrayal page — https://iho.int/en/enc-portrayal; Luciad ECDIS FAQ). _(Edition label caveat: the S-52 spec document is Ed 6.1.1 (June 2015); the Presentation Library itself is Ed 4.0.x — §7.)_

**Mariner safety context parameters (S-101 PC, all 14 verified verbatim):** SafetyDepth (30), SafetyContour (30), FourShades (false), ShallowContour (2; enabled only when FourShades; validated ≤ SafetyContour), DeepContour (enabled when FourShades; validated ≥ SafetyContour), ShallowWaterDangers, PlainBoundaries, SimplifiedSymbols, FullLightLines, RadarOverlay, IgnoreScaleMinimum, PreferredLanguage, SafetyHeight — a renderer must expose these and re-run portrayal when they change (S-101 Portrayal Catalogue portrayal_catalogue.xml `<context>` block).

---

## 5. CRS / datum

### 5.1 Horizontal — WGS84 ellipsoidal, mandated

S-101 ENC horizontal CRS **must be (3D) EPSG:4326 WGS84**; vertical is a 1D vertical datum in metres; geometry is delivered as WGS84 lat/lon: "The horizontal Coordinate Reference System (CRS) for S-101 products must be 3D EPSG:4326 (WGS84). The vertical CRS is reference to a vertical datum, a 1D reference plane…" (S-101PT12-06.8, IHO 2024, primary, full-text — https://iho.int/uploads/user/Services%20and%20Standards/S-100WG/S-101PT12/S-101PT12_2024_06.8_EN_Referencing_Other_Vertical_Datums_V1.pdf).

**Critically for X-GIS:** EPSG:4326 is an **ELLIPSOIDAL** geographic 2D CRS — datum "World Geodetic System 1984 ensemble," ellipsoid WGS 84 **a = 6378137 m, 1/f = 298.257223563** (epsg.io/4326; spatialreference.org/ref/epsg/4326/). There is no spherical datum in S-100 nautical data. _(The "3D EPSG:4326" phrasing is the IHO paper's own informality — 4326 is formally the 2D code; 3D WGS84 is EPSG:4979.)_

**Axis-order hazard:** EPSG:4326 declares **latitude-first**, but S-57/S-101 ENC **encode X=longitude (XCOO), Y=latitude (YCOO)** — ingest must reconcile or points transpose (epsg.io/4326; IHO S-57 Appendix B.1 — https://iho.int/uploads/user/pubs/standards/s-57/20ApB1.pdf). Horizontal coordinates are stored as integers via COMF (default 10⁷ ≈ 1e-7°, ~1.1 cm at equator) (GDAL S-57 driver — https://gdal.org/en/stable/drivers/vector/s57.html).

### 5.2 Vertical datums — decoupled, plural, positive-down

The vertical datum is **decoupled from the geodetic CRS** (metadata, not in the geometry CRS): "Unlike in S-57 the DSID only contains coordinate reference system information for geometries and not for attribute values." Multiple datums may coexist; **datum areas must not overlap**; height contours must be **split at datum borders** (S-101PT12-06.8, primary, verbatim). The M_VDAT enumeration is tidal/level-surface based (3 MSL, 16 MHW, 17 MHWS, 23 LAT, 30 HAT, 44 balticSeaChartDatum2000, …); a new complex "Vertical Reference Frame" attribute (CRS source/identifier/name/offset in m) is **proposed** to relate tidal to 3D geodetic datums (S-101PT12-06.8 Annex A; GDAL S-102 shared-code cross-check).

**Depths use the sounding (chart) datum, canonically LAT (=23).** S-102 gridded depth is **positive-down** ("positive values of depth mean values below the reference surface of the vertical datum") — so any 3-D seafloor extrusion must invert sign (GDAL S-102 driver; S-102 PS draft). S-57 soundings use a separate SOMF factor (default 10, decimetre) (GDAL S-57 driver). S-104 water-level height is referenced to chart datum "not an ellipsoid but the defined chart datum for the area of interest" (GDAL S-104 driver — https://gdal.org/en/latest/drivers/raster/s104.html).

**Part 6 (CRS)** is the conceptual schema for spatial referencing, aligned to **ISO 19111** (current base ed. 2019; EN adoption 2020 + A2:2023), defining 1D/2D/3D references with datum + coordinate-system elements — enabling independent horizontal/vertical + compound CRSs (S-100 Ed 5.2.0 Part 6 description; S-101PT12-06.8 references BS EN ISO 19111:2020+A2:2023). _(Full Part 6 clause text not directly read — >10 MB WebFetch cap — §7.)_

### 5.3 Positional accuracy (distinct from coordinate precision)

Historically carried by **CATZOC** (S-57 object class M_QUAL): A1 ~±5 m (+5% depth), A2 ~±20 m, B ~±50 m, C ~±500 m, D worse, U unassessed; depth accuracy e.g. B ≈ 1.0 m + 2% depth (IHO S-67 Ed 1.0.0 Table 4-1, primary — https://iho.int/uploads/user/pubs/standards/S-67/S-67%20Ed%201.0.0%20Mariners%20Guide%20to%20Accuracy%20of%20Depth%20Information%20in%20an%20ENC_EN.pdf; Teledyne CARIS / Admiralty corroboration). In **S-101** the single composite is replaced by **independent data-quality components** (position, depth, coverage) combined **in the ECDIS by algorithm**, not pre-baked by the producer (Hydro International "Representation of Data Quality in the IHO S-101 Data Model" — https://www.hydro-international.com/content/article/safe-navigation-with-uncertain-hydrographic-data; IHO DQWG report). _(The claim of a "mandatory categoryOfTemporalVariation" is contested — a DQWG source states the attribute was agreed to be removed — §7.)_

---

## 6. X-GIS FIT

> This section is **engineering analysis** layered on the verified facts above. Requirement statements are cited; X-GIS-state statements derive from the engine description given (WebGPU 3D globe, direct vector reprojection + subdivision, normalized-sphere basis, ~21.5 km sphere-vs-ellipsoid offset) plus X-GIS project memory. Effort estimates are rough order-of-magnitude.

### 6.1 What already fits

**A. Direct vector reprojection for S-101 point/line/area — STRONG FIT.**
S-101 geometry is topology level 3a (points, curves, surfaces), 2-D except 3-D point soundings, with clockwise outer boundaries and non-self-intersecting curves (S-101 PS Ed 2.0.0 §4.8.1). This is exactly the primitive set X-GIS's **direct vector reprojection + subdivision** pipeline already renders for MVT/OFM vector tiles — points, polylines, filled polygons with correct winding. An S-101 feature source is a new _ingest adapter_ (ISO 8211 → the engine's existing feature/geometry model), not a new render path. X-GIS's existing z-ordered, data-driven paint pipeline already covers the area→line→point→text draw ordering that Part 9 requires (§9-11.1.6).

**B. S-111 surface currents (vector field) — STRONG FIT to existing GPU primitives.**
S-111 is a gridded speed+direction field at 4.5 m depth (GDAL S-111 driver). X-GIS already ships a **GPU flow-map / arrow primitive** (`map.graphics.add({type:'arrow'})`) and a dual-backend GPU particle-sim flow-field (project memory: flow-map v2, GPU particle-sim). Rendering S-111 as animated arrows or particle advection is a data-adapter problem (HDF5 grid → existing arrow/particle buffers), not new rendering.

**C. Time-series animation scaffolding — PARTIAL FIT.**
X-GIS's setPaintProperty-based flicker-free animation (project memory) is the right substrate for S-104/S-111 per-timestamp playback; the missing piece is the timestamp-indexed data source, not the animation loop.

**D. Day/dusk/night palette switching — FIT via existing data-driven paint.**
S-52's palette model is a token→RGB remap across three palettes (S-101 colorProfile.xml). X-GIS's data-driven paint / colour-constructor runtime (recent `rgb/rgba/hsl/hsla` data-driven channels, commit f01fd1ad) can express a token→RGB lookup as a uniform/palette swap without re-tessellation.

### 6.2 What is MISSING

**GAP 1 — HDF5 gridded-coverage data path (S-102/S-104/S-111). Effort: MEDIUM (multi-session).**
X-GIS is a vector engine; it has **no HDF5 reader** and no gridded-coverage ingest. Required: an HDF5 parser (or a WASM/h5py-equivalent) that walks the Part 10c group hierarchy (Group_F → feature container → feature instance → Group_001..NNN compound `values`), honours DCF-2 regular-grid geometry (gridOrigin*/gridSpacing*/numPoints*) and DCF-3 Positioning groups, and handles the **south-row-first** native ordering (GDAL S-104/S-111 `NORTH_UP`). Output feeds: S-102 → raster DEM texture (colour ramp + optional 3-D extrusion with **positive-down sign inversion**, §5.2); S-104 → per-timestamp height field; S-111 → the existing arrow/particle field. This is the single largest new subsystem, but it is **additive** (a new source type) and does not disturb the vector path. HDF5 1.8.8 profile is stable and well-tooled (GDAL, s100py are reference implementations to validate against).

**GAP 2 — S-52-style rule-based portrayal/symbology engine. Effort: LARGE (epic).**
This is the deepest gap. A conformant S-101 renderer must:

- Execute the **Lua (Part 9a) Portrayal Catalogue** (`PortrayalMain` / `HostPortrayalEmit`, portrayal cache) over SENC features with the 14 mariner context parameters — i.e. **embed a Lua 5.1 interpreter** and implement the host callback contract (Part 9a §9a-14). X-GIS today has a shader-DSL and data-driven paint, but **no rule-engine that maps feature+attribute+context → drawing instructions**; the S-101 PC is ~217 Lua files (S-101 Portrayal Catalogue tree).
- Render the **S-100 SVG Profile (SVG Tiny 1.2 subset)** symbol set (725 SVGs) with pivot points, CSS-class colour tokens, and multiplicative transparency (§9-B; §9-11.1.4). X-GIS has an addImage/sprite-atlas path (project memory #797) that can host rasterized symbols, but SVG-Tiny parsing + the CSS-token colour model + day/dusk/night re-styling is new.
- Implement **Viewing Groups / Display Modes (Base/Standard/Other) / Display Planes / Display Priorities** as a filtering + ordering layer (§9-11).

This is essentially building an ECDIS presentation engine. It is the classic "conditional symbology" problem and should be scoped as its own multi-phase epic, sequenced _after_ GAP 3 (a portrayal engine that draws to the wrong datum is not worth building first).

**GAP 3 — ELLIPSOIDAL datum (the tension with the sphere basis). Effort: HIGH — this is the gating architectural item.**
S-101 **mandates ellipsoidal WGS84 (EPSG:4326)**; there is no spherical datum anywhere in S-100 (S-101PT12-06.8; epsg.io/4326). X-GIS's globe basis is a **normalized SPHERE with a known ~21.5 km sphere-vs-ellipsoid offset** (project memory: parity bug-hunt, ellipsoid anchor 21.5 km; polar-cap f32 tail). For a **hydrographic / navigation** use case, a ~~21.5 km systematic horizontal offset is categorically unacceptable — it dwarfs even CATZOC D (~~±500 m) and the S-101 storage precision (~1.1 cm, COMF 10⁷, §5.1) by three to four orders of magnitude. Navigation safety depends on ellipsoidal fidelity.

This ties directly to X-GIS's **non-Mercator direct-reprojection initiative**, whose central unresolved tension is exactly sphere-vs-ellipsoid (project memory: "REAL SEAM = sphere-vs-ellipsoid ~21 km"; projection CPU/GPU divergences; H2 fill≠outline f32-degree root cause). S-100 support cannot be claimed until the reprojection/geoid authority is ellipsoidal end-to-end (CPU tessellation **and** GPU projection agreeing — X-GIS's dominant bug archetype is exactly two sibling paths diverging sub-pixel, per the fill-vs-outline history). Because vertical datums are decoupled and plural (§5.2), the engine must also carry a **per-area vertical-datum metadata channel** separate from the geodetic CRS — height contours split at datum borders (S-101PT12-06.8) — which the current single-CRS model does not represent.

**Sequencing recommendation:** GAP 3 (ellipsoidal basis) is a prerequisite for any credible S-101/S-102 rendering and should ride the existing non-Mercator ellipsoid initiative to closure first. GAP 1 (HDF5) is independent and can proceed in parallel (S-102/S-104/S-111 gridded coverages, validated against GDAL/s100py). GAP 2 (portrayal engine) is the largest but is last, gated on GAP 3 so symbology is drawn at correct positions.

### 6.3 Fit summary

| S-100 requirement                                                | Source                       | X-GIS today                                              | Gap / effort                       |
| ---------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------- | ---------------------------------- |
| S-101 vector point/line/area (topology 3a)                       | S-101 PS §4.8.1              | Direct vector reproj + subdivision already renders these | **Fits** (new ingest adapter only) |
| S-111 current field (speed/direction)                            | GDAL S-111                   | GPU arrow / particle-sim primitives exist                | **Fits** (HDF5→existing buffers)   |
| Time-series playback (S-104/S-111)                               | GDAL S-104/S-111             | Flicker-free paint-property animation exists             | Partial (needs timestamp source)   |
| Day/dusk/night palette                                           | S-101 colorProfile.xml       | Data-driven colour-constructor runtime                   | **Fits** (token→RGB swap)          |
| HDF5 gridded-coverage ingest                                     | S-100 Part 10c §10c-9        | None                                                     | **GAP 1 — MEDIUM**                 |
| S-52/Part-9a Lua portrayal + SVG-Tiny symbology + viewing groups | S-100 Part 9/9a/9-B          | None (has shader-DSL/data-driven paint, sprite atlas)    | **GAP 2 — LARGE epic**             |
| Ellipsoidal WGS84 datum (mandated)                               | S-101PT12-06.8; epsg.io/4326 | Normalized sphere, ~21.5 km offset                       | **GAP 3 — HIGH, gating**           |
| Decoupled plural vertical datums, positive-down depths           | S-101PT12-06.8; GDAL S-102   | Single-CRS model                                         | Part of GAP 3                      |
| Axis-order / COMF integer coords                                 | S-57 App B.1; GDAL S-57      | N/A (adapter concern)                                    | Minor (ingest adapter)             |

---

## 7. Confidence & gaps — every UNVERIFIED / contested claim

The following did **not** clear the two-source / primary-verbatim bar and must be treated as unconfirmed. None is load-bearing for the §6 feasibility conclusions, but each is disclosed:

1. **S-100 5.2.1 (Dec 2025) part-level content deltas.** All Part 9/9a/9-B/10a/10b/10c/Part 0/Part 13 citations were verified against **Ed 5.2.0 (June 2024)** only; the 20 MB 5.2.0 PDF was fetched, but no 5.2.1 text was fetchable. "No new Parts in 5.2.1" is an inference from the WG10 "clarification edition" framing, not a read changelog. Any 5.2.1 deltas to encoding/portrayal are unverified. Likewise **no Part 10d / no JSON encoding part** is confirmed for 5.2.0 only (absence-of-evidence), not against a 5.2.1 changelog.

2. **S-101 improvements over S-57 — "update features" and "production-system pre-calculated attributes."** Both mechanisms rest on a single older source (Hydro International 2014). Only sub-point (a), text placement via the cartographic feature type, is independently confirmed by the primary spec (§4.3.2.3).

3. **S-57→S-101 remapping crosswalk (RESARE split, CATCOA→NATSUR, CTRPNT→LNDMRK, BRIDGE aggregation, ~1,290 messages).** Single-source (IHR conversion article, one ESRI-converter test on 18 Brazilian ENCs). These are converter-test observations, not an IHO-normative crosswalk; the "1,290 errors" are actually 163 info + 1,127 warnings.

4. **S-101 migration file-naming (`101CCCC…`) and CSCL→minimumDisplayScale/maximumDisplayScale.** Single-source (IHR article). The appended "coordinates retain WGS84/EPSG:4326" tail is **not** in that article (though it is a well-established ENC fact corroborated elsewhere in §5).

5. **"Seven simple attribute value types" (S-101).** Single-source (IHR Table 2); the seven were not transcribed from the DCEG/FC.

6. **Composite-curve support (S-101).** Rests solely on the ECC blog; the term does not appear in S-101 PS §4.8.1 (the cited clause covers the other geometry rules, not composite curves). It is a genuine mechanism but the citation is misplaced.

7. **`categoryOfTemporalVariation` mandatory in S-101 data quality — CONTESTED.** The §5.3 claim asserts it is mandatory, but a DQWG-sourced extract states the attribute was agreed to be **removed** from S-101. Treat as unverified/contested. The specific attribute names (QualityOfBathymetricData.horizontalPositionUncertainty / verticalUncertainty) are from a trade article, not confirmed against the released S-101 DCEG/FC.

8. **S-104 "single-point (fixed-station DCF1) time series" support.** Not verified — s100py S-104 v2.0 implements only DCF2 (gridded); no DCF3/DCF1 class present. The "S-104 supports DCF 3" sub-claim is likewise **not** supported by s100py.

9. **S-111 NOAA production edition — CONTRADICTION.** NOAA developer.html says Ed 1.2.0; the live NOAA S-111 PDS data bucket README states files are compliant with **Ed 1.0.1**. The specific production-edition figure is inconsistent across NOAA sources (IHO edition 2.0.0 is separately confirmed).

10. **HDF5 attribute casing** (gridOriginLongitude, startSequence, numGRP, commonPointRule). Indicative only — s100py exposes snake_case; the exact camelCase HDF5 spellings were not fetched verbatim from a primary Part 10c table.

11. **"3D EPSG:4326" wording** (§5.1) is the IHO paper's own informality — EPSG:4326 is formally the 2D geographic code (3D WGS84 = EPSG:4979). The horizontal-CRS mandate was verified against a **project-team paper (S-101PT12, DCEG 1.2.0 / PS 2.0)**, not the released S-101 Ed 2.0.0 PS clause text (which was not fetched).

12. **CMFX/CMFY per-axis-in-DSSI detail for S-101** is from S-101PT6 conversion guidance (secondary, not re-fetched); S-57 itself uses a single COMF for both axes.

13. **S-102 VERTICAL_DATUM "accepts EPSG codes" — REFUTED for S-102.** GDAL documents S-102 as accepting S-100 codes only (1-30, 44); EPSG acceptance is for S-104, not S-102. Also the "uncertainty is optional" for S-102 is reasonable (BAG-derived, can be a fill value) but not stated literally "optional" in a fetched S-102 primary.

14. **S-52 edition labels.** "Presentation Library (Edition 6.1.1)" conflates two editions: the S-52 _specification document_ is Ed 6.1.1 (June 2015), but the _Presentation Library_ (Annex A / User's Manual) is Ed 4.0.x (currently 4.0.4, Oct 2024). The succession substance is confirmed; the "6.1.1" label on "Presentation Library" is inaccurate. The primary PDF itself also carries a minor internal edition-label inconsistency (6.1.(1) Oct 2014 vs 6.1.1 June 2015).

15. **S-100 Part 6 full clause text / UML** not directly read (>10 MB WebFetch cap); the ISO 19111 alignment is a search-engine extract corroborated by a primary IHO paper's reference list, but the formal 6.x clauses and UML were not transcribed.

16. **S-101 PS/DCEG content provenance.** All S-101 PS/DCEG content in this report is from the **Metanorma reproduction** (marked in-force 2024-12-01, cross-checked against IHO's in-force list), **not** the byte-for-byte IHO-hosted registry PDF (which exceeded the 10 MB fetch limit).

17. **Single-authoritative-source items** (verbatim-matched to the S-100 5.2.0 primary but with no independent second source): GFM Part 3 wording; masking `[MASK]` detail; Part 9 drawing-instruction/viewing-group/transparency/Portrayal-CRS clauses; dataset/exchange-set definitions; `extObjRef` format. These are near-certain (verbatim primary matches) but do not meet a strict two-independent-source bar.

18. **X-GIS-state and effort estimates in §6** are engineering analysis (from the supplied engine description + X-GIS project memory), not from the S-100 corpus. The ~21.5 km offset, GPU-primitive availability, and non-Mercator ellipsoid tension are project-memory facts, not externally cited; effort sizes are rough.
