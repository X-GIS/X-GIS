// X-GIS site component kit — barrel.
//
// The reusable xAI primitives that pages compose from (see ./README.md
// for the full prop API of each). Import from the barrel rather than
// reaching for raw utilities per page:
//
//   import { SectionHead, ContentBand, Card, FeatureRow, Eyebrow } from '@/components/kit'
//
//   <ContentBand id="why">
//     <SectionHead num="01" eyebrow="The Approach"
//       title="Beyond the library." lead="…" />
//   </ContentBand>

export { default as Eyebrow } from './Eyebrow.astro'
export { default as SectionHead } from './SectionHead.astro'
export { default as ContentBand } from './ContentBand.astro'
export { default as Card } from './Card.astro'
export { default as FeatureRow } from './FeatureRow.astro'
