# AGENTS.md

Guidance for AI agents working in this repository.

## Project Style

This project should move toward a clean object-oriented architecture. Prefer classes that own their own behavior, and keep related logic close to the object it describes.

When adding or changing gameplay behavior, first ask: which class should own this? If one of the parameters to a standalone function is already a domain object, that behavior probably belongs as a method on that object or one of its base classes.

Small pure helpers are allowed when they are genuinely generic and do not naturally belong to a domain class. Avoid orphan functions that manipulate unit, building, world, or command state from the outside.

## Units And Buildings

Units should follow the existing `BaseUnit` pattern:

- Add a concrete subclass for each new unit type.
- Put unit-specific behavior, stats, command handling, and special rules in that class.
- Register new unit classes through the unit registry.
- Prefer dynamic dispatch over type switches when unit behavior varies by unit type.

Buildings should follow the same idea:

- Add or extend concrete building classes for new building behavior.
- Put building-specific stats, training rules, resource behavior, combat behavior, and special rules in the building class.
- Register new building classes through the building registry.
- Prefer building methods over external logic that switches on building type.

Existing code may still have some older data-definition files or helper modules. For new work, prefer moving stats and behavior into the relevant class instead of adding more separate definition tables.

## Dynamic Dispatch

When behavior differs by unit type, building type, command handler, or entity kind, consider dynamic dispatch essential unless there is a clear reason not to use it.

Prefer:

- `unit.step(context, unitState, dt)`
- `building.canTrain(unitType)`
- `building.gatherAmount()`
- `unit.canGather()`

Avoid growing large `if`, `else if`, or `switch` blocks that branch on `type` and perform class-specific behavior externally. If the dispatch starts to feel awkward, discuss the alternative with the developer before introducing a different architecture.

## Methods

Methods should be short, readable, and focused on one idea. If a method becomes hard to scan, split it into private methods with clear names.

Good method structure:

- Public methods express the high-level behavior.
- Private methods handle the smaller steps.
- Repeated logic belongs in a base class method or a shared helper only when it is truly shared.
- Avoid duplicated implementations across sibling classes.

Use array methods and other language features when they make code clearer, but do not compress logic so much that it becomes harder to understand.

## TypeScript Types

Avoid repeatedly writing inline object shapes such as `{ x: number; y: number }`.

Prefer named types or interfaces:

- Use existing types such as `Vec2`, `Unit`, `Building`, `ResourceCost`, and command types when they apply.
- Create a named type or interface when the shape is reused or represents a meaningful concept.
- Keep type names in PascalCase.

Inline object types are acceptable for very small one-off cases, but they should not become repeated anonymous shapes across the codebase.

## Server And Client Boundaries

Game rules should be server-authoritative.

Server-side code owns:

- Simulation rules
- Combat outcomes
- Resource gathering and spending
- Building construction
- Unit training
- Zombie behavior
- Pathing and world-state changes

Client-side code should stay focused on:

- Rendering
- User input
- UI state
- Displaying server-provided snapshots

Do not duplicate rule logic on the client to make gameplay decisions. The client may preview or display information, but the server must be the source of truth.

## Grid And Coordinate Conventions

The simulation grid is **isometric / diamond-tile**, but simulation logic does **not** think in screen-cardinal directions. World coordinates increase along the map axes, not screen axes. The render mapping in `public/js/iso.ts` is `screen.y = (world.x + world.y) * TILE_H / 2`, so:

- Increasing world `x` moves the entity **screen-down-right** (SE).
- Increasing world `y` moves the entity **screen-down-left** (SW).
- "Visually below" a target means **larger `x + y`** (the SE/SW screen-south direction), not larger `y` alone.

Symptoms that only appear when a unit approaches from "below" are almost always a sign that some piece of simulation logic is using the wrong tile convention — treat any direction-specific bug as a strong hint to audit the footprint/tile math first.

### Tile convention: floor / top-left (authoritative)

The authoritative simulation, occupancy, and movement convention is **tile-top-left / floor-based**:

- `worldTile(point) = floor(point.x), floor(point.y)` — a point belongs to the tile whose top-left corner it lies in.
- A footprint at `(x, y)` with size `(w, h)` occupies the **half-open** region `[x, x+w) × [y, y+h)`.
- `tileCenter(tile) = (tile.x + 0.5, tile.y + 0.5)` (the geometric center of the tile cell, not the corner).
- Buildings and resources are placed on **integer** tile coordinates, so a 1×1 footprint at `(12, 12)` blocks exactly tile `(12, 12)` = the region `[12, 13) × [12, 13)`.

This convention is used by:

- `src/server/playerUnitPathing.ts` — the movement/flow-field system villagers actually use.
- `src/server/world.ts` — building occupancy and `markOccupancyFootprint` use `Math.floor` + `[x, x+w)`. Resource occupancy currently rounds resource coordinates before marking because resources are integer-placed; if resources ever become fractional, audit `rebuildOccupancy` and `markResourceOccupancy` deliberately.
- `rectsOverlap` / `footprintWidth` / `footprintHeight` in `src/server/math.ts` (top-left AABB).

### Movement near diagonal screen lines

Player pathing can step diagonally in world space, including the screen-south / screen-north diagonals that come from changing both world axes. Diagonal movement must not cut through blocked corners: both side tiles for the diagonal step need to be walkable. If the sides are free, diagonal gaps beside a screen-diagonal or screen-horizontal wall/resource line should be usable.

For plain move commands, keep the shared landing target close to the clicked tile. Formation slots may use clutter scoring to spread a group away from obstacles, but do not apply that clutter penalty to the literal click landing for a single unit or group anchor; otherwise clicking below a wall/resource can snap the target several tiles away and look like the unit refuses to approach.

### Do NOT introduce centered footprint math for simulation

A common mistake is to write footprint bounds as `[x - 0.5, x + w - 0.5)`, treating `(x, y)` as the **center** of the tile instead of its top-left corner. This is **wrong** for simulation:

- It shifts the perceived obstacle by `(-0.5, -0.5)` relative to the real blocked tile.
- Work-points computed from a centered footprint land on **grid intersections** (integer-coordinate corners) rather than tile centers. The interaction flow field searches for walkable goal tiles whose **centers** are within range of the work-point; when the work-point sits on a grid intersection, every adjacent tile center is `~0.707` away and the in-range goal search finds nothing, falling back to the unstable `nearestWalkableAround` path.
- The result is units that settle cleanly from some directions but **bounce in and out of reach when approaching from screen-below** (and other cardinals), because the goal flickers between adjacent tiles frame to frame.

When writing footprint, distance-to-footprint, or work-point logic for any unit/building interaction, use the top-left/floor convention and keep the work-point landing near a tile **center**, not a corner.

```ts
// CORRECT — matches occupancy and movement:
return {
	minX: target.x,
	maxX: target.x + width,
	minY: target.y,
	maxY: target.y + height,
};

// WRONG — centered convention, do not use for simulation:
return {
	minX: target.x - 0.5,
	maxX: target.x + width - 0.5,
	minY: target.y - 0.5,
	maxY: target.y + height - 0.5,
};
```

### Known inconsistency: `centerOf`

There are two `centerOf` implementations that disagree:

- `src/server/world.ts` `centerOf` returns `x + (w - 1) / 2, y + (h - 1) / 2` (center of the discrete tile-index range — the corner of the middle tile).
- `src/server/zombieAi.worker.ts` `centerOf` returns `x + w / 2, y + h / 2` (the true geometric center of the footprint, consistent with the floor/top-left convention).

The geometric form (`w / 2`) is the one consistent with the top-left convention above. The `world.ts` form is older and currently only affects cosmetic/secondary behavior (sound origins, targeting tie-breaks, rally/depot gather points). If you touch `world.ts centerOf`, audit rally-point, depot-gather, tower-targeting, and gather-retarget call sites before changing it — the half-tile shift can move those behaviors. Do not "fix" it as part of an unrelated task without running the full test suite.

### Older pathing subsystem

`src/server/pathing.ts` (used by the zombie director) still uses an older round-based convention (`worldTile = Math.round`, `tileCenter = (x, y)` with no `+0.5`, and `pointInsideCenteredFootprint` with `x - 0.5` bounds). That subsystem is being migrated toward the floor/top-left convention over time. Do not propagate its centered math into villager/player-side code; keep the two systems' conventions distinct and only align them deliberately with full test coverage.

## Refactoring Scope

Only fix style issues directly related to the task at hand.

Do not perform broad opportunistic refactors just because older code does not perfectly match this guide. If an unrelated style problem is worth fixing, mention it separately instead of changing it during the current task.

## Naming

Use standard TypeScript naming:

- Methods, variables, and properties use camelCase, such as `doThing`.
- Classes, interfaces, and type aliases use PascalCase, such as `Thing`.
- Keep names descriptive enough that behavior is clear without reading every call site.

## Formatting And Verification

Follow the repository formatting conventions:

- Tabs for indentation.
- LF line endings.
- Final newline.
- Trim trailing whitespace.

Before finishing changes, run the smallest useful verification for the work. Prefer targeted checks first, then broader checks when the change affects shared behavior.

Useful commands:

- `npm run typecheck`
- `npm run build`
- `npm run test:pathing`
