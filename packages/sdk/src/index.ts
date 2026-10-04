/**
 * The public facade. It re-exports the stable surface and nothing else - if a consumer can
 * reach an internal module from here, a boundary has been broken.
 *
 * Note what is absent: there is no channel adapter and no model provider, because this product
 * deliberately ships neither. See `apps/web/lib/product.ts` for the reason each was omitted,
 * and `AGENTS.md` for the footprint ladder that keeps them out.
 */
export * from '@tickratesim/core'
export * from '@tickratesim/skills'
export * from '@tickratesim/plugins'
export * from '@tickratesim/memory'
