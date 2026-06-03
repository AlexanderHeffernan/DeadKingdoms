# Tiny Isometric Sprite Rules

This MVP art direction uses very small, hand-authored pixel sprites with strict limits.

## Canvas Sizes

- Unit sprites: 16x16 source pixels.
- Small props/resources: 12x12 source pixels.
- Small buildings: 24x24 source pixels.
- Larger buildings: compose from multiple 16x16 chunks instead of making large bespoke sprites.

## Camera

- Use a three-quarter isometric read: visible top, visible front/right side, minimal pure front view.
- Every sprite needs a dark contact shadow near the bottom.
- Avoid stacked decorative tiers unless the silhouette remains connected at source resolution.

## Palette

- Use 3-5 colors per material.
- Prefer strong value separation over detail.
- Shared outline/shadow colors keep sprites cohesive.
- Player color should occupy a small clear band or shield area, not the whole sprite.

## Shape

- At tiny scale, silhouette beats detail.
- One readable feature per sprite:
  - Watch tower: oversized roof + clear platform + tall legs + ladder/pole.
  - Soldier: helmet + face + blue tunic + shield + spear.
  - Tree: crown shape + trunk + shadow.
- If a pixel does not improve silhouette, lighting, team read, or grid contact, remove it.

## Runtime Rendering

- Source sprites should render with nearest-neighbor scaling only.
- Use integer scale factors.
- Preferred in-game scale: 4x to 6x depending on camera zoom.
- Store source art as compact text grids or generated PNGs; SVG is good for inspection, but verbose for production.
