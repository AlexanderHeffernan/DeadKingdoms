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
