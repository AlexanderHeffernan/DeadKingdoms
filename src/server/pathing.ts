import { MAP_SIZE } from "../shared/config.js";
import type { PathNode, Unit, UnitCommand, World } from "../shared/types.js";
import { clamp, distance, moveToward } from "./math.js";
import { MinPriorityQueue } from "./utils/MinPriorityQueue.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";

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

const SEPARATION_CELL_SIZE = 1;
const MIN_SEPARATION_DISTANCE = 0.48;

export function resolveUnitSeparation(world: World) {
	const units = Object.values(world.units);
	const grid = new SpatialGrid(units, SEPARATION_CELL_SIZE);

	for (const entry of grid.entries) {
		for (const other of grid.nearby(entry.item, MIN_SEPARATION_DISTANCE)) {
			if (other.index <= entry.index) continue;
			resolveUnitSeparationPair(world, entry.item, other.item, MIN_SEPARATION_DISTANCE);
		}
	}
}

function resolveUnitSeparationPair(world: World, a: Unit, b: Unit, minDistance: number) {
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
	if (!command.path || command.path.length === 0) {
		command.path = findPath(world, unit, command);
	}
	const waypoint = command.path?.[0] || command;
	unit.facing = waypoint.x < unit.x ? "left" : "right";
	const arrivedWaypoint = moveUnit(world, unit, waypoint, maxStep);
	if (arrivedWaypoint && command.path?.length) command.path.shift();
	return (!command.path || command.path.length === 0) && distance(unit, command) < 0.35;
}

export function moveNearTarget(world: World, unit: Unit, command: UnitCommand, target: { x: number; y: number }, range: number, maxStep: number): boolean {
	if (distance(unit, target) <= range) return true;
	if (!command.path || command.path.length === 0 || world.tick % 12 === 0) {
		command.path = findPath(world, unit, nearestWalkableAround(world, target));
	}
	const waypoint = command.path?.[0] || target;
	unit.facing = waypoint.x < unit.x ? "left" : "right";
	const arrivedWaypoint = moveUnit(world, unit, waypoint, maxStep);
	if (arrivedWaypoint && command.path?.length) command.path.shift();
	return false;
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
