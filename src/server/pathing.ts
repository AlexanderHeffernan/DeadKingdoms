import { MAP_SIZE } from "../shared/config.js";
import type { PathNode, Unit, UnitCommand, Vec2, World } from "../shared/types.js";
import { clamp, distance, footprintHeight, footprintWidth, moveToward, type Footprint } from "./math.js";
import { MinPriorityQueue } from "./utils/MinPriorityQueue.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";

const PATH_REPLAN_TICKS = 25;
const PATH_REQUESTS_PER_TICK = 120;
const ZOMBIE_PATH_REQUESTS_PER_TICK = 6;
const FLOW_FIELD_CACHE_TICKS = 8;
const FLOW_UNREACHED = 0xffffffff;
const FLOW_BASE_COST = 10;
const FLOW_LOOKAHEAD_NODES = 4;
const FOLLOW_PATH_MAX_NODES = 24;
const WIDE_MOVEMENT_MIN_DISTANCE = 8;
const WIDE_MOVEMENT_MAX_LANES = 19;
const WIDE_MOVEMENT_MIN_LANE_WIDTH = 0.2;
const WIDE_MOVEMENT_MAX_LANE_WIDTH = 0.34;
const WAYPOINT_REACHED_DISTANCE = 0.28;
const STUCK_MOVEMENT_EPSILON = 0.015;
const GROUP_ARRIVAL_BASE_RADIUS = 0.8;
const GROUP_ARRIVAL_MAX_RADIUS = 5.5;
const FORMATION_SLOT_SETTLE_RADIUS = 0.65;
const MOVING_COHESION_CELL_SIZE = 1.4;
const MOVING_COHESION_RADIUS = 0.75;
const MOVING_COHESION_STRENGTH = 0.7;
const MOVING_COHESION_NEIGHBORS_PER_UNIT = 8;
const ZOMBIE_STEER_LOOKAHEAD = 3.4;
const ZOMBIE_STEER_MIN_MOVE = 0.005;
const ZOMBIE_CROWD_CELL_SIZE = 1.4;
const ZOMBIE_CROWD_RADIUS = 0.9;
const ZOMBIE_CROWD_STRENGTH = 0.45;
const ZOMBIE_CROWD_NEIGHBORS = 12;
const ZOMBIE_CROWD_TARGET_DISTANCE = 1.2;
const SEPARATION_MAX_PAIRS_PER_TICK = 4500;
const SEPARATION_NEIGHBORS_PER_UNIT = 10;
export const ZOMBIE_PATH_LOOKAHEAD_DISTANCE = 10;
const ZOMBIE_PATH_MAX_NODES = ZOMBIE_PATH_LOOKAHEAD_DISTANCE + 2;

type PathFollowMode = "tight" | "flow";

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
	if (isUnitBlocked(world, unit, target, before)) {
		unit.x = before.x;
		unit.y = before.y;
		return true;
	}
	return arrived;
}

export function moveAroundSmallObstacle(world: World, unit: Unit, target: { x: number; y: number }, maxStep: number): boolean {
	const before = { x: unit.x, y: unit.y };
	const beforeTile = worldTile(before);
	if (isHardOccupied(world, unit, beforeTile.x, beforeTile.y) && escapeOccupiedTile(world, unit, target, maxStep)) return false;
	const arrived = moveToward(unit, target, maxStep);
	if (!isUnitBlocked(world, unit, target, before)) return arrived;
	unit.x = before.x;
	unit.y = before.y;
	if (!isSmallObstacleAhead(world, before, target)) return true;

	for (const sidestepTarget of sidestepTargets(before, target)) {
		const sidestepBefore = { x: unit.x, y: unit.y };
		moveToward(unit, sidestepTarget, maxStep);
		if (!isUnitBlocked(world, unit, sidestepTarget, sidestepBefore)) return false;
		unit.x = sidestepBefore.x;
		unit.y = sidestepBefore.y;
	}
	return true;
}

export function moveZombieSteered(world: World, unit: Unit, target: Vec2, maxStep: number): boolean {
	if (distance(unit, target) <= WAYPOINT_REACHED_DISTANCE) return true;
	const desired = directionBetween(unit, target);
	if (!desired) return true;
	const crowd = distance(unit, target) > ZOMBIE_CROWD_TARGET_DISTANCE ? zombieCrowdPush(world, unit, desired) : { x: 0, y: 0 };
	const candidate = bestZombieSteeringCandidate(world, unit, target, desired, crowd, maxStep);
	if (!candidate) return moveAroundSmallObstacle(world, unit, target, maxStep);
	const before = { x: unit.x, y: unit.y };
	moveToward(unit, candidate.target, maxStep);
	const moved = directionBetween(before, unit);
	if (moved) unit.zombieDriftDirection = moved;
	return distance(unit, target) <= WAYPOINT_REACHED_DISTANCE;
}

function bestZombieSteeringCandidate(world: World, unit: Unit, target: Vec2, desired: Vec2, crowd: Vec2, maxStep: number) {
	const preferredSide = unitHash(unit) % 2 === 0 ? 1 : -1;
	const offsets = steeringAngleOffsets(preferredSide);
	const beforeDistance = distance(unit, target);
	const previousDirection = unit.zombieDriftDirection || null;
	let best: { target: Vec2; score: number } | null = null;

	for (const offset of offsets) {
		const direction = steeredDirection(rotateVector(desired, offset), crowd);
		if (!direction) continue;
		const candidateTarget = {
			x: unit.x + direction.x * ZOMBIE_STEER_LOOKAHEAD,
			y: unit.y + direction.y * ZOMBIE_STEER_LOOKAHEAD,
		};
		const movedTo = candidateStep(world, unit, candidateTarget, maxStep);
		if (!movedTo) continue;
		const progress = beforeDistance - distance(movedTo, target);
		const alignment = direction.x * desired.x + direction.y * desired.y;
		const continuity = previousDirection ? direction.x * previousDirection.x + direction.y * previousDirection.y : 0;
		const crowdAlignment = crowd.x * direction.x + crowd.y * direction.y;
		const score = progress * 8 + alignment + continuity * 1.4 + crowdAlignment * 0.8 - Math.abs(offset) * 0.002;
		if (!best || score > best.score) best = { target: candidateTarget, score };
	}

	return best;
}

function steeringAngleOffsets(preferredSide: number) {
	return [
		0,
		preferredSide * 18,
		-preferredSide * 18,
		preferredSide * 36,
		-preferredSide * 36,
		preferredSide * 58,
		-preferredSide * 58,
		preferredSide * 82,
		-preferredSide * 82,
		preferredSide * 112,
		-preferredSide * 112,
		180,
	];
}

function steeredDirection(direction: Vec2, crowd: Vec2): Vec2 | null {
	const x = direction.x + crowd.x * ZOMBIE_CROWD_STRENGTH;
	const y = direction.y + crowd.y * ZOMBIE_CROWD_STRENGTH;
	const length = Math.hypot(x, y);
	if (length <= 0.001) return null;
	return { x: x / length, y: y / length };
}

function candidateStep(world: World, unit: Unit, target: Vec2, maxStep: number): Vec2 | null {
	if (!canUseMovementWaypoint(world, unit, target)) return null;
	const before = { x: unit.x, y: unit.y };
	moveToward(unit, target, maxStep);
	const movedTo = { x: unit.x, y: unit.y };
	const tile = worldTile(unit);
	const blocked = isHardOccupied(world, unit, tile.x, tile.y) || isUnitBlocked(world, unit, target, before);
	unit.x = before.x;
	unit.y = before.y;
	if (blocked || distance(before, movedTo) < ZOMBIE_STEER_MIN_MOVE) return null;
	return movedTo;
}

function zombieCrowdPush(world: World, unit: Unit, desired: Vec2): Vec2 {
	let pushX = 0;
	let pushY = 0;
	const side = { x: -desired.y, y: desired.x };
	for (const entry of movingZombieGrid(world).nearby(unit, ZOMBIE_CROWD_RADIUS, ZOMBIE_CROWD_NEIGHBORS)) {
		const other = entry.item;
		if (other === unit || other.ownerId !== unit.ownerId) continue;
		const dx = unit.x - other.x;
		const dy = unit.y - other.y;
		const dist = Math.hypot(dx, dy);
		if (dist >= ZOMBIE_CROWD_RADIUS) continue;
		if (dist <= 0.001) {
			const angle = (unitHash(unit) % 360) * Math.PI / 180;
			pushX += Math.cos(angle);
			pushY += Math.sin(angle);
			continue;
		}
		const strength = (ZOMBIE_CROWD_RADIUS - dist) / ZOMBIE_CROWD_RADIUS;
		const away = { x: dx / dist, y: dy / dist };
		pushX += away.x * strength;
		pushY += away.y * strength;
		if (Math.abs(away.x * desired.x + away.y * desired.y) > 0.75) {
			const lateralSide = unitHash(unit) < unitHash(other) ? -1 : 1;
			pushX += side.x * lateralSide * strength;
			pushY += side.y * lateralSide * strength;
		}
	}
	const length = Math.hypot(pushX, pushY);
	if (length <= 0.001) return { x: 0, y: 0 };
	return { x: pushX / length, y: pushY / length };
}

function escapeOccupiedTile(world: World, unit: Unit, target: { x: number; y: number }, maxStep: number): boolean {
	const tile = worldTile(unit);
	const candidates = escapeDirections(unit, target);
	for (const direction of candidates) {
		const escapeTarget = {
			x: unit.x + direction.x,
			y: unit.y + direction.y,
		};
		const before = { x: unit.x, y: unit.y };
		moveToward(unit, escapeTarget, maxStep);
		const escapedTile = worldTile(unit);
		if (!isHardOccupied(world, unit, escapedTile.x, escapedTile.y)) return true;
		unit.x = before.x;
		unit.y = before.y;
	}
	for (const direction of candidates) {
		const x = tile.x + direction.x;
		const y = tile.y + direction.y;
		if (isHardOccupied(world, unit, x, y)) continue;
		unit.x = clamp(x, 0.2, MAP_SIZE - 0.2);
		unit.y = clamp(y, 0.2, MAP_SIZE - 0.2);
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
	const ahead = firstObstacleAhead(world, from, { x: dx / length, y: dy / length });
	if (!ahead) return false;
	let occupiedNeighbors = 0;
	for (let y = ahead.y - 1; y <= ahead.y + 1; y += 1) {
		for (let x = ahead.x - 1; x <= ahead.x + 1; x += 1) {
			if (isHardOccupied(world, undefined, x, y)) occupiedNeighbors += 1;
		}
	}
	return occupiedNeighbors <= 2;
}

function firstObstacleAhead(world: World, from: { x: number; y: number }, direction: { x: number; y: number }) {
	for (let distanceAhead = 0.2; distanceAhead <= 0.95; distanceAhead += 0.15) {
		const x = Math.round(from.x + direction.x * distanceAhead);
		const y = Math.round(from.y + direction.y * distanceAhead);
		if (isHardOccupied(world, undefined, x, y)) return { x, y };
	}
	return null;
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
	const units = Object.values(world.units).filter((unit) => !isMovingUnit(unit));
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
	if (isMovingUnit(a) && isMovingUnit(b)) return 0;
	return MIN_SEPARATION_DISTANCE;
}

function isMovingUnit(unit: Unit): boolean {
	return isMovingCommand(unit.command) || !!unit.hordeTarget;
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
	const tile = worldTile(unit);
	if (isHardOccupied(world, unit, tile.x, tile.y)) {
		unit.x = before.x;
		unit.y = before.y;
	}
}

export function moveWithPath(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, maxStep: number, maxPathNodes = FOLLOW_PATH_MAX_NODES): boolean {
	const baseTarget = moveCommandTarget(world, unit, command);
	const target = formationTarget(world, command, baseTarget);
	const forming = tryApproachFormationTarget(world, unit, command, baseTarget, maxStep);
	if (forming !== null) return forming;
	if (isGroupArrived(world, unit, command, target)) return true;
	const unitTile = worldTile(unit);
	if (isHardOccupied(world, unit, unitTile.x, unitTile.y) && escapeOccupiedTile(world, unit, target, maxStep)) return false;
	if (shouldRefreshPath(world, unit, command, baseTarget)) {
		const path = budgetedPath(world, unit, baseTarget, maxPathNodes);
		if (!path) return false;
		if (path.length === 0 && distance(unit, baseTarget) > exactArrivalRadius(command)) return false;
		command.path = path;
	}
	followPathStep(world, unit, command, target, target, maxStep, movingUnitGrid(world));
	const arrived = tryApproachFormationTarget(world, unit, command, baseTarget, maxStep);
	if (arrived !== null) return arrived;
	return isGroupArrived(world, unit, command, target);
}

export function moveZombieWithPath(world: World, unit: Unit, target: Vec2, maxStep: number): boolean {
	const localTarget = zombiePathTarget(world, unit, target);
	if (!unit.zombiePath && !canRequestZombiePath(world, unit)) return moveAroundSmallObstacle(world, unit, target, maxStep);
	const command: Extract<UnitCommand, { type: "move" }> = {
		type: "move",
		x: localTarget.x,
		y: localTarget.y,
		path: reusableZombiePath(unit, localTarget),
		pathCrowd: 1,
	};
	const arrived = moveWithPath(world, unit, command, maxStep, ZOMBIE_PATH_MAX_NODES);
	unit.zombiePath = command.path || null;
	unit.zombiePathTarget = localTarget;
	return arrived || distance(unit, target) <= WAYPOINT_REACHED_DISTANCE;
}

function canRequestZombiePath(world: World, unit: Unit): boolean {
	const state = pathingState(world);
	if (state.lastRequestTick !== world.tick) {
		state.lastRequestTick = world.tick;
		state.pathRequestsThisTick = 0;
	}
	if (world.tick % PATH_REPLAN_TICKS !== unitPathSlot(unit)) return false;
	if (state.pathRequestsThisTick >= ZOMBIE_PATH_REQUESTS_PER_TICK) return false;
	return true;
}

function zombiePathTarget(world: World, unit: Unit, target: Vec2): Vec2 {
	const dx = target.x - unit.x;
	const dy = target.y - unit.y;
	const length = Math.hypot(dx, dy);
	const rawTarget = length <= ZOMBIE_PATH_LOOKAHEAD_DISTANCE ? target : {
		x: unit.x + (dx / length) * ZOMBIE_PATH_LOOKAHEAD_DISTANCE,
		y: unit.y + (dy / length) * ZOMBIE_PATH_LOOKAHEAD_DISTANCE,
	};
	return tileCenter(nearestWalkableAround(world, rawTarget));
}

function reusableZombiePath(unit: Unit, target: Vec2): PathNode[] | null {
	if (!unit.zombiePathTarget || !unit.zombiePath) return null;
	const previousTarget = worldTile(unit.zombiePathTarget);
	const nextTarget = worldTile(target);
	if (previousTarget.x !== nextTarget.x || previousTarget.y !== nextTarget.y) return null;
	return unit.zombiePath;
}

export function moveNearTarget(world: World, unit: Unit, command: UnitCommand, target: { x: number; y: number }, range: number, maxStep: number): boolean {
	if (distance(unit, target) <= range) return true;
	const approachTarget = interactionApproachTarget(world, unit, target, range);
	const unitTile = worldTile(unit);
	if (isHardOccupied(world, unit, unitTile.x, unitTile.y) && escapeOccupiedTile(world, unit, approachTarget, maxStep)) return false;
	if (shouldRefreshPath(world, unit, command, approachTarget)) command.path = budgetedPath(world, unit, approachTarget);
	followPathStep(world, unit, command, approachTarget, approachTarget, maxStep, movingUnitGrid(world));
	return distance(unit, target) <= range;
}

function interactionApproachTarget(world: World, unit: Unit, target: Vec2, range: number): Vec2 {
	const tile = bestInteractionTile(world, unit, target, range) || nearestWalkableAround(world, target);
	return tileCenter(tile);
}

function bestInteractionTile(world: World, unit: Unit, target: Vec2, range: number): { x: number; y: number } | null {
	const origin = worldTile(target);
	const searchRadius = Math.max(1, Math.ceil(range) + 1);
	let best: { x: number; y: number } | null = null;
	let bestScore = Infinity;
	for (let y = origin.y - searchRadius; y <= origin.y + searchRadius; y += 1) {
		for (let x = origin.x - searchRadius; x <= origin.x + searchRadius; x += 1) {
			if (!isWalkable(world, x, y)) continue;
			const center = tileCenter({ x, y });
			const targetDistance = distance(center, target);
			if (targetDistance > range) continue;
			const score = distance(unit, center) + targetDistance * 0.2;
			if (score < bestScore) {
				best = { x, y };
				bestScore = score;
			}
		}
	}
	return best;
}

function isGroupArrived(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, target: Vec2): boolean {
	if (!command.formationTarget) return distance(unit, target) <= exactArrivalRadius(command);
	if (distance(unit, target) <= FORMATION_SLOT_SETTLE_RADIUS) return true;
	return command.path === null && distance(unit, command) <= arrivalRadius(command);
}

function arrivalRadius(command: UnitCommand): number {
	return Math.min(GROUP_ARRIVAL_MAX_RADIUS, GROUP_ARRIVAL_BASE_RADIUS + Math.sqrt(commandCrowd(command)) * 0.28);
}

function exactArrivalRadius(command: UnitCommand): number {
	return commandCrowd(command) >= 8 ? 0.45 : 0.35;
}

function moveCommandTarget(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>): Vec2 {
	const goal = nearestWalkableAround(world, command, unit);
	return tileCenter(goal);
}

function formationTarget(world: World, command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2): Vec2 {
	return command.formationTarget || baseTarget;
}

function tryApproachFormationTarget(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2, maxStep: number): boolean | null {
	if (!command.formationTarget) return null;
	if (distance(unit, command.formationTarget) <= FORMATION_SLOT_SETTLE_RADIUS) return true;
	if (distance(unit, baseTarget) > formationDeployRadius(command)) return null;
	if (!hasClearMovementLine(world, unit, command.formationTarget)) {
		return distance(unit, baseTarget) <= arrivalRadius(command) ? true : null;
	}
	command.path = null;
	return moveFormationStep(world, unit, command.formationTarget, baseTarget, maxStep);
}

function moveFormationStep(world: World, unit: Unit, target: Vec2, baseTarget: Vec2, maxStep: number): boolean {
	unit.facing = target.x < unit.x ? "left" : "right";
	const before = { x: unit.x, y: unit.y };
	moveAroundSmallObstacle(world, unit, target, maxStep);
	if (enteredOccupiedTile(world, before, unit)) {
		unit.x = before.x;
		unit.y = before.y;
	}
	if (distance(before, unit) < STUCK_MOVEMENT_EPSILON && distance(unit, baseTarget) <= arrivalRadius(unit.command)) return true;
	return distance(unit, target) <= FORMATION_SLOT_SETTLE_RADIUS;
}

function formationDeployRadius(command: UnitCommand): number {
	return Math.min(34, Math.max(arrivalRadius(command) + 2, Math.sqrt(commandCrowd(command)) * 0.95));
}

function followPathStep(world: World, unit: Unit, command: UnitCommand, fallback: Vec2, finalTarget: Vec2, maxStep: number, movingGrid: SpatialGrid<Unit>) {
	const mode = pathFollowMode(command);
	if (mode === "flow") pruneReachablePathPrefix(world, unit, command.path);
	const waypoint = movementWaypoint(world, unit, command, command.path, fallback, finalTarget, movingGrid, mode);
	unit.facing = waypoint.target.x < unit.x ? "left" : "right";
	const before = { x: unit.x, y: unit.y };
	movePathStep(world, unit, waypoint.target, maxStep, mode);
	if (enteredOccupiedTile(world, before, unit)) {
		unit.x = before.x;
		unit.y = before.y;
	}
	if (isStuckAgainstObstacle(before, unit, waypoint.target) && waypoint.target !== waypoint.base) {
		movePathStep(world, unit, waypoint.base, maxStep, mode);
		if (enteredOccupiedTile(world, before, unit)) {
			unit.x = before.x;
			unit.y = before.y;
		}
	}
	const moved = distance(before, unit) >= STUCK_MOVEMENT_EPSILON;
	if (command.path?.length && distance(unit, waypoint.base) <= WAYPOINT_REACHED_DISTANCE) command.path.shift();
	if (!moved) command.path = null;
}

function pathFollowMode(command: UnitCommand): PathFollowMode {
	if (command.type === "gather" || command.type === "build") return "tight";
	return commandCrowd(command) <= 1 ? "tight" : "flow";
}

function movePathStep(world: World, unit: Unit, target: Vec2, maxStep: number, mode: PathFollowMode): boolean {
	return mode === "tight"
		? moveUnit(world, unit, target, maxStep)
		: moveAroundSmallObstacle(world, unit, target, maxStep);
}

function pruneReachablePathPrefix(world: World, unit: Unit, path: PathNode[] | null | undefined) {
	if (!path || path.length <= 1) return;
	while (path.length > 1 && hasClearMovementLine(world, unit, path[1]!)) {
		path.shift();
	}
}

function enteredOccupiedTile(world: World, before: Vec2, unit: Unit): boolean {
	const beforeTile = worldTile(before);
	const nowTile = worldTile(unit);
	const beforeOccupied = isHardOccupied(world, unit, beforeTile.x, beforeTile.y);
	const nowOccupied = isHardOccupied(world, unit, nowTile.x, nowTile.y);
	return nowOccupied && !beforeOccupied;
}

function isStuckAgainstObstacle(before: Vec2, unit: Unit, waypoint: Vec2): boolean {
	return distance(before, unit) < STUCK_MOVEMENT_EPSILON && distance(before, waypoint) > WAYPOINT_REACHED_DISTANCE;
}

function movementWaypoint(world: World, unit: Unit, command: UnitCommand, path: PathNode[] | null | undefined, fallback: Vec2, finalTarget: Vec2, movingGrid: SpatialGrid<Unit>, mode: PathFollowMode): { target: Vec2; base: Vec2 } {
	if (!path || path.length === 0) return { target: fallback, base: fallback };
	const base = path[0]!;
	if (mode === "tight") return { target: base, base };
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
	const tile = worldTile(point);
	if (!isWalkableForUnit(world, unit, tile.x, tile.y)) return false;
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
	const movingUnits = Object.values(world.units).filter(isMovingUnit);
	const grid = new SpatialGrid(movingUnits, MOVING_COHESION_CELL_SIZE);
	state.movingUnitGrid = grid;
	state.movingUnitGridTick = world.tick;
	return grid;
}

function movingZombieGrid(world: World): SpatialGrid<Unit> {
	const state = pathingState(world);
	if (state.movingZombieGridTick === world.tick && state.movingZombieGrid) return state.movingZombieGrid as SpatialGrid<Unit>;
	const zombies = Object.values(world.units).filter((unit) => unit.type === "zombie" && unit.hp > 0 && isMovingUnit(unit));
	const grid = new SpatialGrid(zombies, ZOMBIE_CROWD_CELL_SIZE);
	state.movingZombieGrid = grid;
	state.movingZombieGridTick = world.tick;
	return grid;
}

function hasClearMovementLine(world: World, unit: Unit, point: Vec2): boolean {
	const dx = point.x - unit.x;
	const dy = point.y - unit.y;
	const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.25));
	for (let i = 1; i <= steps; i += 1) {
		const x = unit.x + (dx * i) / steps;
		const y = unit.y + (dy * i) / steps;
		const tile = worldTile({ x, y });
		if (!isWalkableForUnit(world, unit, tile.x, tile.y)) return false;
	}
	return true;
}

function unitLane(unit: Unit, crowd: number): number {
	const lanes = movementLanesForCrowd(crowd);
	return (unitHash(unit) % lanes) - Math.floor(lanes / 2);
}

function movementLanesForCrowd(crowd: number): number {
	if (crowd >= 500) return WIDE_MOVEMENT_MAX_LANES;
	if (crowd >= 220) return 17;
	if (crowd >= 120) return 15;
	if (crowd >= 70) return 13;
	if (crowd >= 35) return 11;
	if (crowd >= 16) return 9;
	return 5;
}

function laneWidthForCrowd(crowd: number): number {
	if (crowd >= 120) return WIDE_MOVEMENT_MAX_LANE_WIDTH;
	if (crowd >= 35) return 0.28;
	if (crowd >= 8) return 0.24;
	return WIDE_MOVEMENT_MIN_LANE_WIDTH;
}

function shouldRefreshPath(world: World, unit: Unit, command: UnitCommand, target: Vec2): boolean {
	if (!command.path || command.path.length === 0) return true;
	if (world.tick % PATH_REPLAN_TICKS !== unitPathSlot(unit)) return false;
	const final = command.path.at(-1);
	if (!final) return true;
	const finalTile = worldTile(final);
	const targetTile = worldTile(target);
	return finalTile.x !== targetTile.x || finalTile.y !== targetTile.y;
}

function budgetedPath(world: World, unit: Unit, target: Vec2, maxNodes = FOLLOW_PATH_MAX_NODES): PathNode[] | null {
	if (!canRequestPath(world, unit)) return null;
	consumePathRequest(world);
	if (hasPassableGateFor(unit, world)) return findPath(world, unit, target).slice(0, maxNodes);
	return findSharedPath(world, unit, target, maxNodes, commandCrowd(unit.command));
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

function isUnitBlocked(world: World, unit: Unit, target: { x: number; y: number }, before: Vec2): boolean {
	const tile = worldTile(unit);
	const tileX = tile.x;
	const tileY = tile.y;
	if (!isHardOccupied(world, unit, tileX, tileY)) return false;
	// Check if the occupant is a building the unit is standing on (e.g. just spawned)
	for (const building of Object.values(world.buildings)) {
		if (pointInsideCenteredFootprint(unit, building)) {
			if (distance(unit, target) <= building.size + 0.8) return false;
			return true;
		}
	}
	// Otherwise it's a resource tile: blocked unless we're close to our target.
	return distance(unit, target) > 1.6 || sameTile(unit, before);
}

function isHardOccupied(world: World, unit: Unit | undefined, x: number, y: number): boolean {
	if (!occupied(world, x, y)) return false;
	if (unit && isOwnGateTile(world, unit, x, y)) return false;
	if (hardBlockingTiles(world).has(tileId(x, y))) return true;
	if (!unit || !isMovingUnit(unit)) return true;
	const idleOwners = idleUnitTiles(world).get(tileId(x, y));
	if (!idleOwners || idleOwners.size !== 1) return true;
	return idleOwners.get(unit.ownerId) !== 1;
}

function hardBlockingTiles(world: World): Set<number> {
	const state = pathingState(world);
	if (state.hardBlockingTilesVersion === state.occupancyVersion && state.hardBlockingTiles) return state.hardBlockingTiles as Set<number>;
	const tiles = new Set<number>();
	for (const resource of Object.values(world.resources)) {
		const { x, y } = worldTile(resource);
		if (isInMap(x, y)) tiles.add(tileId(x, y));
	}
	for (const building of Object.values(world.buildings)) {
		if (!building.walkBlocking) continue;
		for (let dy = 0; dy < building.height; dy += 1) {
			for (let dx = 0; dx < building.width; dx += 1) {
				const x = building.x + dx;
				const y = building.y + dy;
				if (isInMap(x, y)) tiles.add(tileId(x, y));
			}
		}
	}
	state.hardBlockingTiles = tiles;
	state.hardBlockingTilesVersion = state.occupancyVersion;
	return tiles;
}

function idleUnitTiles(world: World): Map<number, Map<string, number>> {
	const state = pathingState(world);
	if (state.idleUnitTilesTick === world.tick && state.idleUnitTiles) return state.idleUnitTiles as Map<number, Map<string, number>>;
	const tiles = new Map<number, Map<string, number>>();
	for (const unit of Object.values(world.units)) {
		if (isMovingUnit(unit)) continue;
		const tile = worldTile(unit);
		const id = tileId(tile.x, tile.y);
		const owners = tiles.get(id) || new Map<string, number>();
		owners.set(unit.ownerId, (owners.get(unit.ownerId) || 0) + 1);
		tiles.set(id, owners);
	}
	state.idleUnitTiles = tiles;
	state.idleUnitTilesTick = world.tick;
	return tiles;
}

function sameTile(a: Vec2, b: Vec2): boolean {
	const aTile = worldTile(a);
	const bTile = worldTile(b);
	return aTile.x === bTile.x && aTile.y === bTile.y;
}

export function findPath(world: World, unit: Unit, target: { x: number; y: number }): PathNode[] {
	const start = worldTile(unit);
	const goal = nearestWalkableAround(world, target, unit);
	if (!isInMap(goal.x, goal.y)) return [];
	if (start.x === goal.x && start.y === goal.y) return [tileCenter(goal)];
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
			if (!isWalkableForUnit(world, unit, next.x, next.y) && !(next.x === goal.x && next.y === goal.y)) continue;
			if (dir.x !== 0 && dir.y !== 0 && (!isWalkableForUnit(world, unit, current.x + dir.x, current.y) || !isWalkableForUnit(world, unit, current.x, current.y + dir.y))) continue;
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
	const start = worldTile(unit);
	const goal = nearestWalkableAround(world, target);
	if (!isInMap(goal.x, goal.y)) return [];
	if (start.x === goal.x && start.y === goal.y) return [tileCenter(goal)];
	const field = flowFieldFor(world, goal, clearanceRadiusForCrowd(crowd));
	let current = tileId(start.x, start.y);
	if (field.distance[current] === FLOW_UNREACHED) return findPath(world, unit, target);
	const path: PathNode[] = [];
	for (let i = 0; i < maxNodes && current !== field.goalId; i += 1) {
		const next = bestFlowStep(world, field, current);
		if (next < 0 || next === current) break;
		current = next;
		path.push(tileCenter({ x: current % MAP_SIZE, y: Math.floor(current / MAP_SIZE) }));
	}
	return path;
}

function commandCrowd(command: UnitCommand): number {
	return Math.max(1, command.pathCrowd || 1);
}

function clearanceRadiusForCrowd(crowd: number): number {
	if (crowd >= 180) return 4;
	if (crowd >= 80) return 3;
	if (crowd >= 28) return 2;
	if (crowd >= 12) return 1;
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
	return shortage * shortage * 42;
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

function nearestWalkableAround(world: World, target: { x: number; y: number }, unit?: Unit) {
	const origin = worldTile(target);
	const canWalk = (x: number, y: number) => unit ? isWalkableForUnit(world, unit, x, y) : isWalkable(world, x, y);
	if (canWalk(origin.x, origin.y)) return origin;
	let best = origin;
	let bestDistance = Infinity;
	for (let radius = 1; radius <= 6; radius += 1) {
		for (let y = origin.y - radius; y <= origin.y + radius; y += 1) {
			for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
				if (Math.abs(x - origin.x) !== radius && Math.abs(y - origin.y) !== radius) continue;
				if (!canWalk(x, y)) continue;
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

export function nearestWalkablePointAround(world: World, target: Vec2, unit?: Unit): Vec2 {
	return tileCenter(nearestWalkableAround(world, target, unit));
}

function isWalkableForUnit(world: World, unit: Unit, x: number, y: number): boolean {
	if (!isInMap(x, y)) return false;
	return !occupied(world, x, y) || isOwnGateTile(world, unit, x, y);
}

function occupied(world: World, x: number, y: number): boolean {
	if (!world._occupancy) return false;
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return true;
	return world._occupancy[y * MAP_SIZE + x] === 1;
}

function isOwnGateTile(world: World, unit: Unit, x: number, y: number) {
	return Object.values(world.buildings).some((building) => (
		building.type === "gate" &&
		building.ownerId === unit.ownerId &&
		x >= building.x &&
		x < building.x + building.width &&
		y >= building.y &&
		y < building.y + building.height
	));
}

function hasPassableGateFor(unit: Unit, world: World) {
	return Object.values(world.buildings).some((building) => building.type === "gate" && building.ownerId === unit.ownerId);
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

function tileCenter(tile: { x: number; y: number }): Vec2 {
	return { x: tile.x, y: tile.y };
}

function worldTile(point: Vec2): { x: number; y: number } {
	return { x: Math.round(point.x), y: Math.round(point.y) };
}

function pointInsideCenteredFootprint(point: Vec2, entity: Footprint): boolean {
	return point.x >= entity.x - 0.5 && point.x < entity.x + footprintWidth(entity) - 0.5 && point.y >= entity.y - 0.5 && point.y < entity.y + footprintHeight(entity) - 0.5;
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

function directionBetween(from: Vec2, to: Vec2): Vec2 | null {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length <= 0.001) return null;
	return { x: dx / length, y: dy / length };
}

function rotateVector(vector: Vec2, degrees: number): Vec2 {
	if (degrees === 0) return vector;
	const radians = degrees * Math.PI / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return {
		x: vector.x * cos - vector.y * sin,
		y: vector.x * sin + vector.y * cos,
	};
}

function unpackPath(node: PathNode): PathNode[] {
	const path = [];
	let current = node;
	while (current?.parent) {
		path.push(tileCenter(current));
		current = current.parent;
	}
	path.reverse();
	return path;
}
