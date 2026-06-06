import { MAP_SIZE } from "../shared/config.js";
import type { PathNode, Unit, UnitCommand, Vec2, World } from "../shared/types.js";
import { clamp, distance, moveToward } from "./math.js";
import { MinPriorityQueue } from "./utils/MinPriorityQueue.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";

const PATH_REPLAN_TICKS = 25;
const PATH_REQUESTS_PER_TICK = 120;
const FLOW_FIELD_CACHE_TICKS = 8;
const FLOW_UNREACHED = 0xffffffff;
const FLOW_BASE_COST = 10;
const FLOW_LOOKAHEAD_NODES = 4;
const FOLLOW_PATH_MAX_NODES = 24;
const WIDE_MOVEMENT_MIN_DISTANCE = 8;
const WIDE_MOVEMENT_MAX_LANES = 13;
const WIDE_MOVEMENT_MIN_LANE_WIDTH = 0.16;
const WIDE_MOVEMENT_MAX_LANE_WIDTH = 0.24;
const WAYPOINT_REACHED_DISTANCE = 0.28;
const STUCK_MOVEMENT_EPSILON = 0.015;
const GROUP_ARRIVAL_BASE_RADIUS = 0.8;
const GROUP_ARRIVAL_MAX_RADIUS = 5.5;
const FORMATION_SLOT_SETTLE_RADIUS = 0.65;
const MOVING_COHESION_CELL_SIZE = 1.4;
const MOVING_COHESION_RADIUS = 0.75;
const MOVING_COHESION_STRENGTH = 0.7;
const MOVING_COHESION_NEIGHBORS_PER_UNIT = 8;
const SEPARATION_MAX_PAIRS_PER_TICK = 4500;
const SEPARATION_NEIGHBORS_PER_UNIT = 10;

type FlowField = {
	goalId: number;
	createdTick: number;
	clearanceRadius: number;
	distance: Uint32Array;
	next: Int32Array;
};

export function moveUnit(world: World, unit: Unit, target: { x: number; y: number }, maxStep: number): boolean {
	const before = { x: unit.x, y: unit.y };
	const arrived = moveToward(unit, target, maxStep);
	if (isUnitBlocked(world, unit, target)) {
		unit.x = before.x;
		unit.y = before.y;
		return true;
	}
	return arrived;
}

export function moveAroundSmallObstacle(world: World, unit: Unit, target: { x: number; y: number }, maxStep: number): boolean {
	const before = { x: unit.x, y: unit.y };
	if (occupied(world, Math.floor(before.x), Math.floor(before.y)) && escapeOccupiedTile(world, unit, target, maxStep)) return false;
	const arrived = moveToward(unit, target, maxStep);
	if (!isUnitBlocked(world, unit, target)) return arrived;
	unit.x = before.x;
	unit.y = before.y;
	if (!isSmallObstacleAhead(world, before, target)) return true;

	for (const sidestepTarget of sidestepTargets(before, target)) {
		const sidestepBefore = { x: unit.x, y: unit.y };
		moveToward(unit, sidestepTarget, maxStep);
		if (!isUnitBlocked(world, unit, sidestepTarget)) return false;
		unit.x = sidestepBefore.x;
		unit.y = sidestepBefore.y;
	}
	return true;
}

function escapeOccupiedTile(world: World, unit: Unit, target: { x: number; y: number }, maxStep: number): boolean {
	const tile = { x: Math.floor(unit.x), y: Math.floor(unit.y) };
	const candidates = escapeDirections(unit, target);
	for (const direction of candidates) {
		const escapeTarget = {
			x: unit.x + direction.x,
			y: unit.y + direction.y,
		};
		const before = { x: unit.x, y: unit.y };
		moveToward(unit, escapeTarget, maxStep);
		if (!occupied(world, Math.floor(unit.x), Math.floor(unit.y))) return true;
		unit.x = before.x;
		unit.y = before.y;
	}
	for (const direction of candidates) {
		const x = tile.x + direction.x;
		const y = tile.y + direction.y;
		if (occupied(world, x, y)) continue;
		unit.x = clamp(x + 0.5, 0.2, MAP_SIZE - 0.2);
		unit.y = clamp(y + 0.5, 0.2, MAP_SIZE - 0.2);
		return true;
	}
	return false;
}

function escapeDirections(from: { x: number; y: number }, target: { x: number; y: number }) {
	const dx = target.x - from.x;
	const dy = target.y - from.y;
	const length = Math.hypot(dx, dy) || 1;
	const forward = { x: Math.round(dx / length), y: Math.round(dy / length) };
	const directions = [
		forward,
		{ x: -forward.y, y: forward.x },
		{ x: forward.y, y: -forward.x },
		{ x: forward.x - forward.y, y: forward.y + forward.x },
		{ x: forward.x + forward.y, y: forward.y - forward.x },
		{ x: -forward.x, y: -forward.y },
		{ x: 1, y: 0 },
		{ x: -1, y: 0 },
		{ x: 0, y: 1 },
		{ x: 0, y: -1 },
	];
	return directions.filter((direction, index) => {
		if (direction.x === 0 && direction.y === 0) return false;
		return directions.findIndex((other) => other.x === direction.x && other.y === direction.y) === index;
	});
}

function isSmallObstacleAhead(world: World, from: { x: number; y: number }, target: { x: number; y: number }): boolean {
	const dx = target.x - from.x;
	const dy = target.y - from.y;
	const length = Math.hypot(dx, dy) || 1;
	const ahead = {
		x: Math.floor(from.x + (dx / length) * 0.75),
		y: Math.floor(from.y + (dy / length) * 0.75),
	};
	if (!occupied(world, ahead.x, ahead.y)) return false;
	let occupiedNeighbors = 0;
	for (let y = ahead.y - 1; y <= ahead.y + 1; y += 1) {
		for (let x = ahead.x - 1; x <= ahead.x + 1; x += 1) {
			if (occupied(world, x, y)) occupiedNeighbors += 1;
		}
	}
	return occupiedNeighbors <= 2;
}

function sidestepTargets(from: { x: number; y: number }, target: { x: number; y: number }) {
	const dx = target.x - from.x;
	const dy = target.y - from.y;
	const length = Math.hypot(dx, dy) || 1;
	const nx = dx / length;
	const ny = dy / length;
	const side = Math.sin(from.x * 12.9898 + from.y * 78.233) > 0 ? 1 : -1;
	const forward = 0.35;
	const lateral = 1.2;
	return [
		{ x: from.x + nx * forward + -ny * lateral * side, y: from.y + ny * forward + nx * lateral * side },
		{ x: from.x + nx * forward + ny * lateral * side, y: from.y + ny * forward + -nx * lateral * side },
	];
}

const SEPARATION_CELL_SIZE = 1;
const MIN_SEPARATION_DISTANCE = 0.48;

export function resolveUnitSeparation(world: World) {
	const units = Object.values(world.units).filter((unit) => !isMovingCommand(unit.command));
	const grid = new SpatialGrid(units, SEPARATION_CELL_SIZE);
	let pairs = 0;

	for (const entry of grid.entries) {
		if (pairs >= SEPARATION_MAX_PAIRS_PER_TICK) break;
		for (const other of grid.nearby(entry.item, MIN_SEPARATION_DISTANCE, SEPARATION_NEIGHBORS_PER_UNIT)) {
			if (other.index <= entry.index) continue;
			pairs += 1;
			resolveUnitSeparationPair(world, entry.item, other.item, separationDistance(entry.item, other.item));
			if (pairs >= SEPARATION_MAX_PAIRS_PER_TICK) break;
		}
	}
}

function separationDistance(a: Unit, b: Unit): number {
	if (isMovingCommand(a.command) && isMovingCommand(b.command)) return 0;
	return MIN_SEPARATION_DISTANCE;
}

function isMovingCommand(command: UnitCommand): boolean {
	if (command.type === "move") return command.path !== null;
	if ((command.type === "attack" || command.type === "gather" || command.type === "build") && command.path && command.path.length > 0) return true;
	return false;
}

function resolveUnitSeparationPair(world: World, a: Unit, b: Unit, minDistance: number) {
	if (minDistance <= 0) return;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const dist = Math.hypot(dx, dy);
	if (dist >= minDistance) return;
	const push = (minDistance - (dist || 0.001)) / 2;
	const nx = dist ? dx / dist : 1;
	const ny = dist ? dy / dist : 0;
	nudgeUnit(world, a, -nx * push, -ny * push);
	nudgeUnit(world, b, nx * push, ny * push);
}

function nudgeUnit(world: World, unit: Unit, dx: number, dy: number) {
	const before = { x: unit.x, y: unit.y };
	unit.x = clamp(unit.x + dx, 0.2, MAP_SIZE - 0.2);
	unit.y = clamp(unit.y + dy, 0.2, MAP_SIZE - 0.2);
	if (occupied(world, Math.floor(unit.x), Math.floor(unit.y))) {
		unit.x = before.x;
		unit.y = before.y;
	}
}

export function moveWithPath(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, maxStep: number): boolean {
	const baseTarget = moveCommandTarget(world, command);
	const target = formationTarget(world, command, baseTarget);
	if (isGroupArrived(world, unit, command, target)) return true;
	if (occupied(world, Math.floor(unit.x), Math.floor(unit.y)) && escapeOccupiedTile(world, unit, target, maxStep)) return false;
	if (shouldRefreshPath(world, unit, command, baseTarget)) command.path = budgetedPath(world, unit, baseTarget);
	followPathStep(world, unit, command, target, target, maxStep, movingUnitGrid(world));
	return isGroupArrived(world, unit, command, target);
}

export function moveNearTarget(world: World, unit: Unit, command: UnitCommand, target: { x: number; y: number }, range: number, maxStep: number): boolean {
	if (distance(unit, target) <= range) return true;
	const goal = nearestWalkableAround(world, target);
	if (occupied(world, Math.floor(unit.x), Math.floor(unit.y)) && escapeOccupiedTile(world, unit, goal, maxStep)) return false;
	if (shouldRefreshPath(world, unit, command, goal)) command.path = budgetedPath(world, unit, goal);
	followPathStep(world, unit, command, target, target, maxStep, movingUnitGrid(world));
	return false;
}

function isGroupArrived(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, target: Vec2): boolean {
	if (!command.formationOffset) return distance(unit, target) <= exactArrivalRadius(command);
	if (distance(unit, target) <= FORMATION_SLOT_SETTLE_RADIUS) return true;
	return command.path === null && distance(unit, command) <= arrivalRadius(command);
}

function arrivalRadius(command: UnitCommand): number {
	return Math.min(GROUP_ARRIVAL_MAX_RADIUS, GROUP_ARRIVAL_BASE_RADIUS + Math.sqrt(commandCrowd(command)) * 0.28);
}

function exactArrivalRadius(command: UnitCommand): number {
	return commandCrowd(command) >= 8 ? 0.45 : 0.35;
}

function moveCommandTarget(world: World, command: Extract<UnitCommand, { type: "move" }>): Vec2 {
	const goal = nearestWalkableAround(world, command);
	return { x: goal.x + 0.5, y: goal.y + 0.5 };
}

function formationTarget(world: World, command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2): Vec2 {
	const offset = command.formationOffset;
	if (!offset) return baseTarget;
	const target = {
		x: clamp(baseTarget.x + offset.x, 0.2, MAP_SIZE - 0.2),
		y: clamp(baseTarget.y + offset.y, 0.2, MAP_SIZE - 0.2),
	};
	return isWalkable(world, Math.floor(target.x), Math.floor(target.y)) ? target : baseTarget;
}

function followPathStep(world: World, unit: Unit, command: UnitCommand, fallback: Vec2, finalTarget: Vec2, maxStep: number, movingGrid: SpatialGrid<Unit>) {
	pruneReachablePathPrefix(world, unit, command.path);
	const waypoint = movementWaypoint(world, unit, command, command.path, fallback, finalTarget, movingGrid);
	unit.facing = waypoint.target.x < unit.x ? "left" : "right";
	const before = { x: unit.x, y: unit.y };
	moveAroundSmallObstacle(world, unit, waypoint.target, maxStep);
	if (enteredOccupiedTile(world, before, unit)) {
		unit.x = before.x;
		unit.y = before.y;
	}
	if (isStuckAgainstObstacle(before, unit, waypoint.target) && waypoint.target !== waypoint.base) {
		moveAroundSmallObstacle(world, unit, waypoint.base, maxStep);
		if (enteredOccupiedTile(world, before, unit)) {
			unit.x = before.x;
			unit.y = before.y;
		}
	}
	const moved = distance(before, unit) >= STUCK_MOVEMENT_EPSILON;
	if (command.path?.length && distance(unit, waypoint.base) <= WAYPOINT_REACHED_DISTANCE) command.path.shift();
	if (!moved) command.path = null;
}

function pruneReachablePathPrefix(world: World, unit: Unit, path: PathNode[] | null | undefined) {
	if (!path || path.length <= 1) return;
	while (path.length > 1 && hasClearMovementLine(world, unit, path[1]!)) {
		path.shift();
	}
}

function enteredOccupiedTile(world: World, before: Vec2, unit: Unit): boolean {
	const beforeOccupied = occupied(world, Math.floor(before.x), Math.floor(before.y));
	const nowOccupied = occupied(world, Math.floor(unit.x), Math.floor(unit.y));
	return nowOccupied && !beforeOccupied;
}

function isStuckAgainstObstacle(before: Vec2, unit: Unit, waypoint: Vec2): boolean {
	return distance(before, unit) < STUCK_MOVEMENT_EPSILON && distance(before, waypoint) > WAYPOINT_REACHED_DISTANCE;
}

function movementWaypoint(world: World, unit: Unit, command: UnitCommand, path: PathNode[] | null | undefined, fallback: Vec2, finalTarget: Vec2, movingGrid: SpatialGrid<Unit>): { target: Vec2; base: Vec2 } {
	if (!path || path.length === 0) return { target: fallback, base: fallback };
	const base = path[0]!;
	const lookahead = path[Math.min(path.length - 1, FLOW_LOOKAHEAD_NODES)]!;
	if (path.length <= FLOW_LOOKAHEAD_NODES || distance(unit, finalTarget) < WIDE_MOVEMENT_MIN_DISTANCE) return { target: lookahead, base };
	const dx = lookahead.x - unit.x;
	const dy = lookahead.y - unit.y;
	const length = Math.hypot(dx, dy);
	if (length <= 0.001) return { target: lookahead, base };
	const lane = unitLane(unit, commandCrowd(command));
	if (lane === 0) return { target: lookahead, base };
	const offset = lane * laneWidthForCrowd(commandCrowd(command));
	const candidate = {
		x: lookahead.x + (-dy / length) * offset,
		y: lookahead.y + (dx / length) * offset,
	};
	const spacedCandidate = movingSpacingWaypoint(world, unit, candidate, movingGrid);
	if (canUseMovementWaypoint(world, unit, spacedCandidate)) return { target: spacedCandidate, base };
	const halfCandidate = {
		x: lookahead.x + (-dy / length) * offset * 0.5,
		y: lookahead.y + (dx / length) * offset * 0.5,
	};
	const spacedHalfCandidate = movingSpacingWaypoint(world, unit, halfCandidate, movingGrid);
	if (canUseMovementWaypoint(world, unit, spacedHalfCandidate)) return { target: spacedHalfCandidate, base };
	const spacedLookahead = movingSpacingWaypoint(world, unit, lookahead, movingGrid);
	return canUseMovementWaypoint(world, unit, spacedLookahead) ? { target: spacedLookahead, base } : { target: lookahead, base };
}

function canUseMovementWaypoint(world: World, unit: Unit, point: Vec2): boolean {
	if (!isWalkable(world, Math.floor(point.x), Math.floor(point.y))) return false;
	return hasClearMovementLine(world, unit, point);
}

function movingSpacingWaypoint(world: World, unit: Unit, target: Vec2, movingGrid: SpatialGrid<Unit>): Vec2 {
	let pushX = 0;
	let pushY = 0;
	for (const entry of movingGrid.nearby(unit, MOVING_COHESION_RADIUS, MOVING_COHESION_NEIGHBORS_PER_UNIT)) {
		const other = entry.item;
		if (other === unit || other.ownerId !== unit.ownerId) continue;
		const dx = unit.x - other.x;
		const dy = unit.y - other.y;
		const dist = Math.hypot(dx, dy);
		if (dist <= 0.001 || dist >= MOVING_COHESION_RADIUS) continue;
		const strength = (MOVING_COHESION_RADIUS - dist) / MOVING_COHESION_RADIUS;
		pushX += (dx / dist) * strength;
		pushY += (dy / dist) * strength;
	}
	if (pushX === 0 && pushY === 0) return target;
	const length = Math.hypot(pushX, pushY) || 1;
	const adjusted = {
		x: target.x + (pushX / length) * MOVING_COHESION_STRENGTH,
		y: target.y + (pushY / length) * MOVING_COHESION_STRENGTH,
	};
	return canUseMovementWaypoint(world, unit, adjusted) ? adjusted : target;
}

function movingUnitGrid(world: World): SpatialGrid<Unit> {
	const state = pathingState(world);
	if (state.movingUnitGridTick === world.tick && state.movingUnitGrid) return state.movingUnitGrid as SpatialGrid<Unit>;
	const movingUnits = Object.values(world.units).filter((unit) => isMovingCommand(unit.command));
	const grid = new SpatialGrid(movingUnits, MOVING_COHESION_CELL_SIZE);
	state.movingUnitGrid = grid;
	state.movingUnitGridTick = world.tick;
	return grid;
}

function hasClearMovementLine(world: World, unit: Unit, point: Vec2): boolean {
	const dx = point.x - unit.x;
	const dy = point.y - unit.y;
	const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.25));
	for (let i = 1; i <= steps; i += 1) {
		const x = unit.x + (dx * i) / steps;
		const y = unit.y + (dy * i) / steps;
		if (!isWalkable(world, Math.floor(x), Math.floor(y))) return false;
	}
	return true;
}

function unitLane(unit: Unit, crowd: number): number {
	const lanes = movementLanesForCrowd(crowd);
	return (unitHash(unit) % lanes) - Math.floor(lanes / 2);
}

function movementLanesForCrowd(crowd: number): number {
	if (crowd >= 120) return WIDE_MOVEMENT_MAX_LANES;
	if (crowd >= 70) return 11;
	if (crowd >= 35) return 9;
	if (crowd >= 16) return 7;
	return 5;
}

function laneWidthForCrowd(crowd: number): number {
	if (crowd >= 35) return WIDE_MOVEMENT_MAX_LANE_WIDTH;
	if (crowd >= 8) return 0.2;
	return WIDE_MOVEMENT_MIN_LANE_WIDTH;
}

function shouldRefreshPath(world: World, unit: Unit, command: UnitCommand, target: Vec2): boolean {
	if (!command.path || command.path.length === 0) return true;
	if (world.tick % PATH_REPLAN_TICKS !== unitPathSlot(unit)) return false;
	const final = command.path.at(-1);
	if (!final) return true;
	return Math.floor(final.x) !== Math.floor(target.x) || Math.floor(final.y) !== Math.floor(target.y);
}

function budgetedPath(world: World, unit: Unit, target: Vec2): PathNode[] | null {
	if (!canRequestPath(world, unit)) return null;
	consumePathRequest(world);
	return findSharedPath(world, unit, target, FOLLOW_PATH_MAX_NODES, commandCrowd(unit.command));
}

function canRequestPath(world: World, unit: Unit): boolean {
	const state = pathingState(world);
	if (state.lastRequestTick !== world.tick) {
		state.lastRequestTick = world.tick;
		state.pathRequestsThisTick = 0;
	}
	if (state.pathRequestsThisTick < PATH_REQUESTS_PER_TICK) return true;
	return world.tick % PATH_REPLAN_TICKS === unitPathSlot(unit);
}

function consumePathRequest(world: World) {
	const state = pathingState(world);
	state.pathRequestsThisTick += 1;
}

function unitPathSlot(unit: Unit): number {
	return unitHash(unit) % PATH_REPLAN_TICKS;
}

function unitHash(unit: Unit): number {
	let hash = 0;
	for (let i = 0; i < unit.id.length; i += 1) hash = (hash * 31 + unit.id.charCodeAt(i)) | 0;
	return Math.abs(hash);
}

function isUnitBlocked(world: World, unit: Unit, target: { x: number; y: number }): boolean {
	const tileX = Math.floor(unit.x);
	const tileY = Math.floor(unit.y);
	if (!occupied(world, tileX, tileY)) return false;
	// Check if the occupant is a building the unit is standing on (e.g. just spawned)
	for (const building of Object.values(world.buildings)) {
		if (unit.x >= building.x && unit.x < building.x + building.size && unit.y >= building.y && unit.y < building.y + building.size) {
			if (distance(unit, target) <= building.size + 0.8) return false;
			return true;
		}
	}
	// Otherwise it's a resource tile: blocked unless we're close to our target.
	return distance(unit, target) > 1.6;
}

export function findPath(world: World, unit: Unit, target: { x: number; y: number }): PathNode[] {
	const start = { x: Math.floor(unit.x), y: Math.floor(unit.y) };
	const goal = nearestWalkableAround(world, target);
	if (!isInMap(goal.x, goal.y)) return [];
	if (start.x === goal.x && start.y === goal.y) return [{ x: goal.x + 0.5, y: goal.y + 0.5 }];
	const startNode: PathNode = { ...start, g: 0, f: heuristic(start, goal), parent: null };
	const open = new MinPriorityQueue<PathNode>((node) => node.f ?? 0);
	open.push(startNode);
	const best = new Map([[key(start), startNode]]);
	const closed = new Set();
	const dirs = [
		{ x: 1, y: 0 },
		{ x: -1, y: 0 },
		{ x: 0, y: 1 },
		{ x: 0, y: -1 },
		{ x: 1, y: 1 },
		{ x: 1, y: -1 },
		{ x: -1, y: 1 },
		{ x: -1, y: -1 },
	];
	for (let iterations = 0; open.length && iterations < 900; iterations++) {
		const current = open.pop()!;
		if (best.get(key(current)) !== current) continue;
		if (current.x === goal.x && current.y === goal.y) return unpackPath(current);
		closed.add(key(current));
		// looping through neighbors
		for (const dir of dirs) {
			const next = { x: current.x + dir.x, y: current.y + dir.y };
			// skip closed nodes
			if (!isInMap(next.x, next.y) || closed.has(key(next))) continue;
			if (!isWalkable(world, next.x, next.y) && !(next.x === goal.x && next.y === goal.y)) continue;
			if (dir.x !== 0 && dir.y !== 0 && (!isWalkable(world, current.x + dir.x, current.y) || !isWalkable(world, current.x, current.y + dir.y))) continue;
			const cost = (current.g ?? 0) + (dir.x !== 0 && dir.y !== 0 ? 1.4 : 1);
			const existing = best.get(key(next));
			if (existing && (existing.g ?? 0) <= cost) continue;
			const node = { ...next, g: cost, f: cost + heuristic(next, goal), parent: current };
			best.set(key(next), node);
			open.push(node);
		}
	}
	return [];
}

export function findSharedPath(world: World, unit: Unit, target: Vec2, maxNodes = MAP_SIZE * 2, crowd = 1): PathNode[] {
	const start = { x: Math.floor(unit.x), y: Math.floor(unit.y) };
	const goal = nearestWalkableAround(world, target);
	if (!isInMap(goal.x, goal.y)) return [];
	if (start.x === goal.x && start.y === goal.y) return [{ x: goal.x + 0.5, y: goal.y + 0.5 }];
	const field = flowFieldFor(world, goal, clearanceRadiusForCrowd(crowd));
	let current = tileId(start.x, start.y);
	if (field.distance[current] === FLOW_UNREACHED) return findPath(world, unit, target);
	const path: PathNode[] = [];
	for (let i = 0; i < maxNodes && current !== field.goalId; i += 1) {
		const next = bestFlowStep(world, field, current);
		if (next < 0 || next === current) break;
		current = next;
		path.push({ x: (current % MAP_SIZE) + 0.5, y: Math.floor(current / MAP_SIZE) + 0.5 });
	}
	return path;
}

function commandCrowd(command: UnitCommand): number {
	return Math.max(1, command.pathCrowd || 1);
}

function clearanceRadiusForCrowd(crowd: number): number {
	if (crowd >= 120) return 6;
	if (crowd >= 70) return 5;
	if (crowd >= 35) return 4;
	if (crowd >= 16) return 3;
	if (crowd >= 8) return 2;
	return 0;
}

function bestFlowStep(world: World, field: FlowField, current: number): number {
	if (field.clearanceRadius > 0) return field.next[current]!;
	const x = current % MAP_SIZE;
	const y = Math.floor(current / MAP_SIZE);
	let best = field.next[current]!;
	let bestDistance = best >= 0 ? field.distance[best]! : FLOW_UNREACHED;
	for (let dy = -1; dy <= 1; dy += 1) {
		for (let dx = -1; dx <= 1; dx += 1) {
			if (dx === 0 && dy === 0) continue;
			const nx = x + dx;
			const ny = y + dy;
			if (!isInMap(nx, ny) || !isWalkable(world, nx, ny)) continue;
			if (dx !== 0 && dy !== 0 && (!isWalkable(world, x + dx, y) || !isWalkable(world, x, y + dy))) continue;
			const id = tileId(nx, ny);
			const d = field.distance[id]!;
			if (d < bestDistance) {
				best = id;
				bestDistance = d;
			}
		}
	}
	return best;
}

function flowFieldFor(world: World, goal: { x: number; y: number }, clearanceRadius: number): FlowField {
	const state = pathingState(world);
	const goalId = tileId(goal.x, goal.y);
	const cacheKey = `${state.occupancyVersion}:${goalId}:${clearanceRadius}`;
	const cached = state.flowFields.get(cacheKey) as FlowField | undefined;
	if (cached && world.tick - cached.createdTick <= FLOW_FIELD_CACHE_TICKS) return cached;
	const field = buildFlowField(world, goalId, clearanceRadius);
	state.flowFields.set(cacheKey, field);
	if (state.flowFields.size > 48) pruneFlowFields(state.flowFields as Map<string, FlowField>, world.tick);
	return field;
}

function buildFlowField(world: World, goalId: number, clearanceRadius: number): FlowField {
	if (clearanceRadius <= 0) return buildUnweightedFlowField(world, goalId);
	const distanceGrid = new Uint32Array(MAP_SIZE * MAP_SIZE);
	distanceGrid.fill(FLOW_UNREACHED);
	const next = new Int32Array(MAP_SIZE * MAP_SIZE);
	next.fill(-1);
	const clearance = clearanceRadius > 0 ? clearanceField(world) : null;
	const open = new MinPriorityQueue<{ id: number; cost: number }>((node) => node.cost);
	distanceGrid[goalId] = 0;
	next[goalId] = goalId;
	open.push({ id: goalId, cost: 0 });
	while (open.length) {
		const currentNode = open.pop()!;
		const current = currentNode.id;
		if (currentNode.cost !== distanceGrid[current]) continue;
		const x = current % MAP_SIZE;
		const y = Math.floor(current / MAP_SIZE);
		touchFlowNeighbor(world, distanceGrid, next, open, clearance, clearanceRadius, current, x + 1, y, FLOW_BASE_COST);
		touchFlowNeighbor(world, distanceGrid, next, open, clearance, clearanceRadius, current, x - 1, y, FLOW_BASE_COST);
		touchFlowNeighbor(world, distanceGrid, next, open, clearance, clearanceRadius, current, x, y + 1, FLOW_BASE_COST);
		touchFlowNeighbor(world, distanceGrid, next, open, clearance, clearanceRadius, current, x, y - 1, FLOW_BASE_COST);
	}
	return { goalId, createdTick: world.tick, clearanceRadius, distance: distanceGrid, next };
}

function buildUnweightedFlowField(world: World, goalId: number): FlowField {
	const distanceGrid = new Uint32Array(MAP_SIZE * MAP_SIZE);
	distanceGrid.fill(FLOW_UNREACHED);
	const next = new Int32Array(MAP_SIZE * MAP_SIZE);
	next.fill(-1);
	const queue = new Int32Array(MAP_SIZE * MAP_SIZE);
	let head = 0;
	let tail = 0;
	distanceGrid[goalId] = 0;
	next[goalId] = goalId;
	queue[tail++] = goalId;
	while (head < tail) {
		const current = queue[head++]!;
		const x = current % MAP_SIZE;
		const y = Math.floor(current / MAP_SIZE);
		const nextDistance = distanceGrid[current]! + FLOW_BASE_COST;
		if (touchUnweightedFlowNeighbor(world, distanceGrid, next, queue, tail, current, x + 1, y, nextDistance)) tail += 1;
		if (touchUnweightedFlowNeighbor(world, distanceGrid, next, queue, tail, current, x - 1, y, nextDistance)) tail += 1;
		if (touchUnweightedFlowNeighbor(world, distanceGrid, next, queue, tail, current, x, y + 1, nextDistance)) tail += 1;
		if (touchUnweightedFlowNeighbor(world, distanceGrid, next, queue, tail, current, x, y - 1, nextDistance)) tail += 1;
	}
	return { goalId, createdTick: world.tick, clearanceRadius: 0, distance: distanceGrid, next };
}

function touchUnweightedFlowNeighbor(
	world: World,
	distanceGrid: Uint32Array,
	next: Int32Array,
	queue: Int32Array,
	tail: number,
	current: number,
	x: number,
	y: number,
	nextDistance: number,
) {
	if (!isInMap(x, y) || !isWalkable(world, x, y)) return false;
	const id = tileId(x, y);
	if (distanceGrid[id] !== FLOW_UNREACHED) return false;
	distanceGrid[id] = nextDistance;
	next[id] = current;
	queue[tail] = id;
	return true;
}

function touchFlowNeighbor(
	world: World,
	distanceGrid: Uint32Array,
	next: Int32Array,
	open: MinPriorityQueue<{ id: number; cost: number }>,
	clearance: Uint8Array | null,
	clearanceRadius: number,
	current: number,
	x: number,
	y: number,
	stepCost: number,
) {
	if (!isInMap(x, y) || !isWalkable(world, x, y)) return false;
	const currentX = current % MAP_SIZE;
	const currentY = Math.floor(current / MAP_SIZE);
	if (x !== currentX && y !== currentY && (!isWalkable(world, x, currentY) || !isWalkable(world, currentX, y))) return false;
	const id = tileId(x, y);
	const nextDistance = distanceGrid[current]! + stepCost + clearancePenalty(clearance, clearanceRadius, id);
	if (nextDistance >= distanceGrid[id]!) return false;
	distanceGrid[id] = nextDistance;
	next[id] = current;
	open.push({ id, cost: nextDistance });
	return true;
}

function clearancePenalty(clearance: Uint8Array | null, clearanceRadius: number, id: number): number {
	if (!clearance || clearanceRadius <= 0) return 0;
	const distanceFromObstacle = clearance[id]!;
	if (distanceFromObstacle >= clearanceRadius) return 0;
	const shortage = clearanceRadius - distanceFromObstacle;
	return shortage * shortage * 70;
}

function clearanceField(world: World): Uint8Array {
	const state = pathingState(world);
	const cached = state.clearanceFields.get(state.occupancyVersion) as Uint8Array | undefined;
	if (cached) return cached;
	const field = buildClearanceField(world);
	state.clearanceFields.set(state.occupancyVersion, field);
	return field;
}

function buildClearanceField(world: World): Uint8Array {
	const clearance = new Uint8Array(MAP_SIZE * MAP_SIZE);
	clearance.fill(255);
	const queue = new Int32Array(MAP_SIZE * MAP_SIZE);
	let head = 0;
	let tail = 0;
	for (let y = 0; y < MAP_SIZE; y += 1) {
		for (let x = 0; x < MAP_SIZE; x += 1) {
			if (!occupied(world, x, y) && x > 0 && y > 0 && x < MAP_SIZE - 1 && y < MAP_SIZE - 1) continue;
			const id = tileId(x, y);
			clearance[id] = 0;
			queue[tail++] = id;
		}
	}
	while (head < tail) {
		const current = queue[head++]!;
		const x = current % MAP_SIZE;
		const y = Math.floor(current / MAP_SIZE);
		const nextDistance = clearance[current]! + 1;
		if (nextDistance > 254) continue;
		if (touchClearanceNeighbor(clearance, queue, tail, x + 1, y, nextDistance)) tail += 1;
		if (touchClearanceNeighbor(clearance, queue, tail, x - 1, y, nextDistance)) tail += 1;
		if (touchClearanceNeighbor(clearance, queue, tail, x, y + 1, nextDistance)) tail += 1;
		if (touchClearanceNeighbor(clearance, queue, tail, x, y - 1, nextDistance)) tail += 1;
	}
	return clearance;
}

function touchClearanceNeighbor(clearance: Uint8Array, queue: Int32Array, tail: number, x: number, y: number, nextDistance: number): boolean {
	if (!isInMap(x, y)) return false;
	const id = tileId(x, y);
	if (clearance[id]! <= nextDistance) return false;
	clearance[id] = nextDistance;
	queue[tail] = id;
	return true;
}

function pruneFlowFields(fields: Map<string, FlowField>, tick: number) {
	for (const [key, field] of fields) {
		if (tick - field.createdTick > FLOW_FIELD_CACHE_TICKS) fields.delete(key);
	}
	if (fields.size <= 48) return;
	for (const key of fields.keys()) {
		fields.delete(key);
		if (fields.size <= 36) return;
	}
}

function nearestWalkableAround(world: World, target: { x: number; y: number }) {
	const origin = { x: Math.floor(target.x), y: Math.floor(target.y) };
	if (isWalkable(world, origin.x, origin.y)) return origin;
	let best = origin;
	let bestDistance = Infinity;
	for (let radius = 1; radius <= 6; radius += 1) {
		for (let y = origin.y - radius; y <= origin.y + radius; y += 1) {
			for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
				if (Math.abs(x - origin.x) !== radius && Math.abs(y - origin.y) !== radius) continue;
				if (!isWalkable(world, x, y)) continue;
				const d = Math.hypot(x - target.x, y - target.y);
				if (d < bestDistance) {
					best = { x, y };
					bestDistance = d;
				}
			}
		}
		if (bestDistance < Infinity) return best;
	}
	return best;
}

export function isWalkable(world: World, x: number, y: number): boolean {
	if (!isInMap(x, y)) return false;
	return !occupied(world, x, y);
}

function occupied(world: World, x: number, y: number): boolean {
	if (!world._occupancy) return false;
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return true;
	return world._occupancy[y * MAP_SIZE + x] === 1;
}

function isInMap(x: number, y: number) {
	return x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE;
}

function key(point: { x: number; y: number }): string {
	return `${point.x},${point.y}`;
}

function tileId(x: number, y: number): number {
	return y * MAP_SIZE + x;
}

function pathingState(world: World) {
	if (!world._pathing) {
		world._pathing = {
			occupancyVersion: 0,
			flowFields: new Map(),
			clearanceFields: new Map(),
			arrivalGroups: new Map(),
			pathRequestsThisTick: 0,
			lastRequestTick: -1,
		};
	}
	return world._pathing;
}

function heuristic(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function unpackPath(node: PathNode): PathNode[] {
	const path = [];
	let current = node;
	while (current?.parent) {
		path.push({ x: current.x + 0.5, y: current.y + 0.5 });
		current = current.parent;
	}
	path.reverse();
	return path;
}
