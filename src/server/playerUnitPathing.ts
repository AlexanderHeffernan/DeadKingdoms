import { MAP_SIZE } from "../shared/config.js";
import type { PathNode, ResourceNode, Unit, UnitCommand, Vec2, World } from "../shared/types.js";
import { clamp, distance, moveToward } from "./math.js";
import { MinPriorityQueue } from "./utils/MinPriorityQueue.js";
import { SpatialGrid } from "./utils/SpatialGrid.js";

const FLOW_UNREACHED = 0xffffffff;
const FLOW_BASE_COST = 10;
const FLOW_DIAGONAL_COST = 14;
const FLOW_CACHE_TICKS = 600;
const FLOW_CACHE_LIMIT = 64;
const LOOKAHEAD_STEPS = 5;
const STUCK_MOVEMENT_EPSILON = 0.012;
const CLEAR_LINE_SAMPLE_STEP = 0.2;
const GROUP_ARRIVAL_BASE_RADIUS = 0.9;
const GROUP_ARRIVAL_MAX_RADIUS = 8.5;
const FORMATION_SLOT_SETTLE_RADIUS = 0.85;
const FORMATION_SLOT_PRACTICAL_SETTLE_RADIUS = 1.35;
const FORMATION_SLOT_CLOSE_SETTLE_RADIUS = 2.8;
const FORMATION_SLOT_CLOSE_STUCK_TICKS = 2;
const FORMATION_DEPLOY_MAX_RADIUS = 38;
const INTERACTION_PRACTICAL_PADDING = 0.7;
const INTERACTION_PRACTICAL_STUCK_TICKS = 4;
const INTERACTION_PROGRESS_EPSILON = 0.25;
const MOVING_UNIT_CELL_SIZE = 1.5;
const MOVING_UNIT_RADIUS = 0.85;
const MOVING_UNIT_PUSH_STRENGTH = 0.55;
const MOVING_UNIT_NEIGHBORS = 10;
const RESOURCE_CLEARANCE_RADIUS = 1.7;
const RESOURCE_CLEARANCE_STRENGTH = 0.85;
const STEERING_LOOKAHEAD = 2.8;
const STEERING_MIN_MOVE = 0.004;
const NEAREST_WALKABLE_RADIUS = 24;
const INTERACTION_GOAL_PADDING = 2;

type FlowField = {
	goalId: number;
	createdTick: number;
	distance: Uint32Array;
	next: Int32Array;
};

type SteeringTarget = {
	target: Vec2;
	base: Vec2;
	field: FlowField | null;
	finalTarget: Vec2;
};

export class PlayerUnitPathfinder {
	public constructor(private readonly world: World) {}

	public moveWithPath(unit: Unit, command: Extract<UnitCommand, { type: "move" }>, maxStep: number): boolean {
		return movePlayerUnitWithPath(this.world, unit, command, maxStep);
	}

	public moveNearTarget(unit: Unit, command: UnitCommand, target: Vec2, range: number, maxStep: number): boolean {
		return movePlayerUnitNearTarget(this.world, unit, command, target, range, maxStep);
	}
}

export function movePlayerUnitWithPath(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, maxStep: number): boolean {
	const baseTarget = moveCommandTarget(world, unit, command);
	const finalTarget = formationTarget(command, baseTarget);
	if (isMoveComplete(world, unit, command, baseTarget, finalTarget)) return true;
	if (escapeOccupiedTile(world, unit, baseTarget, maxStep)) return false;

	const steeringTarget = movementTarget(world, unit, command, baseTarget, finalTarget);
	const before = { x: unit.x, y: unit.y };
	const beforeFinalDistance = distance(unit, finalTarget);
	movePlayerUnitSteered(world, unit, steeringTarget, maxStep, pathFollowMode(command));
	const movedDistance = distance(before, unit);
	const finalProgress = beforeFinalDistance - distance(unit, finalTarget);
	updateMovePathDebug(world, command, steeringTarget);

	if (isMoveComplete(world, unit, command, baseTarget, finalTarget)) return true;
	if (isPracticalGroupComplete(world, unit, command, baseTarget, finalTarget, movedDistance, finalProgress)) return true;
	return false;
}

export function movePlayerUnitNearTarget(world: World, unit: Unit, command: UnitCommand, target: Vec2, range: number, maxStep: number): boolean {
	if (distance(unit, target) <= range) {
		resetInteractionProgress(command);
		return true;
	}
	if (escapeOccupiedTile(world, unit, target, maxStep)) return false;
	const field = interactionFlowField(world, unit, target, range);
	const steeringTarget = fieldTarget(world, unit, field, target);
	const before = { x: unit.x, y: unit.y };
	const beforeDistance = distance(unit, target);
	movePlayerUnitSteered(world, unit, steeringTarget, maxStep, "tight");
	const afterDistance = distance(unit, target);
	command.path = debugPathFromTarget(steeringTarget);
	if (distance(before, unit) < STUCK_MOVEMENT_EPSILON) command.path = null;
	const arrived = afterDistance <= range;
	trackInteractionProgress(world, unit, command, target, range, field, beforeDistance, afterDistance, arrived);
	return arrived || isPracticalInteractionComplete(command, afterDistance, range);
}

function moveCommandTarget(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>): Vec2 {
	if (command.moveGroupTarget) return nearestWalkablePointAround(world, command.moveGroupTarget, unit);
	return nearestWalkablePointAround(world, command, unit);
}

function formationTarget(command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2): Vec2 {
	return command.formationTarget || baseTarget;
}

function movementTarget(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2, finalTarget: Vec2): SteeringTarget {
	if (shouldDeployFormation(unit, command, baseTarget)) {
		return directTarget(world, unit, finalTarget, baseTarget);
	}
	const goalTile = nearestWalkableAround(world, baseTarget, unit);
	const field = flowField(world, unit, goalTile, clearancePenaltyForCrowd(commandCrowd(command)));
	const target = fieldTarget(world, unit, field, baseTarget);
	if (!command.formationTarget || distance(unit, baseTarget) > formationDeployRadius(command)) {
		return applyGroupLane(world, unit, command, target);
	}
	return target;
}

function shouldDeployFormation(unit: Unit, command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2): boolean {
	if (!command.formationTarget) return false;
	if (distance(unit, baseTarget) > formationDeployRadius(command)) return false;
	return true;
}

function directTarget(world: World, unit: Unit, target: Vec2, finalTarget: Vec2): SteeringTarget {
	const tile = worldTile(target);
	if (isWalkableForUnit(world, unit, tile.x, tile.y) && hasClearMovementLine(world, unit, target)) {
		return { target, base: target, field: null, finalTarget };
	}
	const walkable = nearestWalkablePointAround(world, target, unit);
	return { target: walkable, base: walkable, field: null, finalTarget };
}

function fieldTarget(world: World, unit: Unit, field: FlowField, finalTarget: Vec2): SteeringTarget {
	const unitTile = worldTile(unit);
	const current = tileId(unitTile.x, unitTile.y);
	if (!isInMap(unitTile.x, unitTile.y) || field.distance[current] === FLOW_UNREACHED) {
		const fallback = nearestReachablePointToward(world, unit, field, finalTarget);
		return { target: fallback, base: fallback, field, finalTarget };
	}
	let next = current;
	for (let i = 0; i < LOOKAHEAD_STEPS && next !== field.goalId; i += 1) {
		const candidate = bestFlowStep(world, unit, field, next);
		if (candidate < 0 || candidate === next) break;
		next = candidate;
	}
	const base = tileCenterById(next);
	return { target: base, base, field, finalTarget };
}

function applyGroupLane(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, target: SteeringTarget): SteeringTarget {
	const crowd = commandCrowd(command);
	if (crowd < 8 || distance(unit, target.finalTarget) < 8) return target;
	const dx = target.target.x - unit.x;
	const dy = target.target.y - unit.y;
	const length = Math.hypot(dx, dy);
	if (length <= 0.001) return target;
	const lane = unitLane(unit, crowd);
	if (lane === 0) return target;
	const offset = lane * laneWidth(crowd);
	const laneTarget = {
		x: target.target.x + (-dy / length) * offset,
		y: target.target.y + (dx / length) * offset,
	};
	const tile = worldTile(laneTarget);
	if (!isWalkableForUnit(world, unit, tile.x, tile.y) || !hasClearMovementLine(world, unit, laneTarget)) return target;
	return { ...target, target: laneTarget };
}

function hasNearbyHardObstacle(world: World, unit: Unit, radius: number): boolean {
	const tile = worldTile(unit);
	for (let y = tile.y - radius; y <= tile.y + radius; y += 1) {
		for (let x = tile.x - radius; x <= tile.x + radius; x += 1) {
			if (isHardOccupied(world, unit, x, y)) return true;
		}
	}
	return false;
}

function movePlayerUnitSteered(world: World, unit: Unit, steeringTarget: SteeringTarget, maxStep: number, mode: "tight" | "flow") {
	unit.facing = steeringTarget.target.x < unit.x ? "left" : "right";
	const desired = directionBetween(unit, steeringTarget.target);
	if (!desired) return;
	const crowdPush = mode === "flow" ? movingUnitPush(world, unit) : { x: 0, y: 0 };
	const resourcePush = mode === "flow" ? resourceClearancePush(world, unit) : { x: 0, y: 0 };
	const candidate = bestSteeringCandidate(world, unit, steeringTarget, desired, crowdPush, resourcePush, maxStep, mode);
	const target = candidate || steeringTarget.base;
	const before = { x: unit.x, y: unit.y };
	moveToward(unit, target, maxStep);
	if (movementBlocked(world, unit, before)) {
		unit.x = before.x;
		unit.y = before.y;
	}
}

function bestSteeringCandidate(
	world: World,
	unit: Unit,
	steeringTarget: SteeringTarget,
	desired: Vec2,
	crowdPush: Vec2,
	resourcePush: Vec2,
	maxStep: number,
	mode: "tight" | "flow",
): Vec2 | null {
	const preferredSide = unitHash(unit.id) % 2 === 0 ? 1 : -1;
	const offsets = steeringAngleOffsets(preferredSide, mode);
	const beforeCost = flowCostAt(world, steeringTarget.field, unit);
	const beforeGoalDistance = distance(unit, steeringTarget.finalTarget);
	let best: { target: Vec2; score: number } | null = null;

	if (steeringTarget.field && hasNearbyHardObstacle(world, unit, 2)) {
		const immediateFlowStep = immediateFlowStepTarget(world, unit, steeringTarget.field, maxStep);
		if (immediateFlowStep) return immediateFlowStep;
	}

	if (mode === "flow") {
		const preferred = preferredSteeringTarget(world, unit, steeringTarget, desired, crowdPush, resourcePush, maxStep, beforeCost, beforeGoalDistance);
		if (preferred) return preferred;
	}

	for (const offset of offsets) {
		const direction = steeredDirection(rotateVector(desired, offset), crowdPush, resourcePush, mode);
		if (!direction) continue;
		const candidateTarget = {
			x: unit.x + direction.x * STEERING_LOOKAHEAD,
			y: unit.y + direction.y * STEERING_LOOKAHEAD,
		};
		const movedTo = candidateStep(world, unit, candidateTarget, maxStep, mode);
		if (!movedTo) continue;
		const cost = flowCostAt(world, steeringTarget.field, movedTo);
		const costProgress = beforeCost === FLOW_UNREACHED || cost === FLOW_UNREACHED ? 0 : beforeCost - cost;
		const goalProgress = beforeGoalDistance - distance(movedTo, steeringTarget.finalTarget);
		const alignment = direction.x * desired.x + direction.y * desired.y;
		const score = costProgress * 0.85 + goalProgress * 7 + alignment * 1.5 - Math.abs(offset) * 0.004;
		if (!best || score > best.score) best = { target: candidateTarget, score };
	}

	if (!best && mode === "flow") {
		return localFlowRecoveryTarget(world, unit, steeringTarget, maxStep, beforeCost, beforeGoalDistance);
	}
	return best?.target || null;
}

function immediateFlowStepTarget(world: World, unit: Unit, field: FlowField | null, maxStep: number): Vec2 | null {
	if (!field) return null;
	const tile = worldTile(unit);
	if (!isInMap(tile.x, tile.y)) return null;
	const current = tileId(tile.x, tile.y);
	const next = bestFlowStep(world, unit, field, current);
	if (next < 0 || next === current) return null;
	const target = tileCenterById(next);
	return candidateStep(world, unit, target, maxStep, "flow") ? target : null;
}

function preferredSteeringTarget(
	world: World,
	unit: Unit,
	steeringTarget: SteeringTarget,
	desired: Vec2,
	crowdPush: Vec2,
	resourcePush: Vec2,
	maxStep: number,
	beforeCost: number,
	beforeGoalDistance: number,
): Vec2 | null {
	const direction = steeredDirection(desired, crowdPush, resourcePush, "flow");
	if (!direction) return null;
	const target = {
		x: unit.x + direction.x * STEERING_LOOKAHEAD,
		y: unit.y + direction.y * STEERING_LOOKAHEAD,
	};
	const movedTo = candidateStep(world, unit, target, maxStep, "flow");
	if (!movedTo) return null;
	const afterCost = flowCostAt(world, steeringTarget.field, movedTo);
	const costProgress = beforeCost === FLOW_UNREACHED || afterCost === FLOW_UNREACHED ? 0 : beforeCost - afterCost;
	const goalProgress = beforeGoalDistance - distance(movedTo, steeringTarget.finalTarget);
	if (costProgress < 0 && goalProgress < -0.04) return null;
	return target;
}

function candidateStep(world: World, unit: Unit, target: Vec2, maxStep: number, mode: "tight" | "flow"): Vec2 | null {
	if (!canUseMovementWaypoint(world, unit, target, mode)) return null;
	const before = { x: unit.x, y: unit.y };
	moveToward(unit, target, maxStep);
	const movedTo = { x: unit.x, y: unit.y };
	const blocked = movementBlocked(world, unit, before);
	unit.x = before.x;
	unit.y = before.y;
	if (blocked || distance(before, movedTo) < STEERING_MIN_MOVE) return null;
	return movedTo;
}

function localFlowRecoveryTarget(
	world: World,
	unit: Unit,
	steeringTarget: SteeringTarget,
	maxStep: number,
	beforeCost: number,
	beforeGoalDistance: number,
): Vec2 | null {
	const unitTile = worldTile(unit);
	let best: { target: Vec2; score: number } | null = null;
	for (const direction of FLOW_DIRECTIONS) {
		const x = unitTile.x + direction.x;
		const y = unitTile.y + direction.y;
		if (!canStepBetweenTiles(world, unit, unitTile.x, unitTile.y, x, y)) continue;
		const target = tileCenter({ x, y });
		const movedTo = candidateStep(world, unit, target, maxStep, "flow");
		if (!movedTo) continue;
		const cost = flowCostAt(world, steeringTarget.field, movedTo);
		const costProgress = beforeCost === FLOW_UNREACHED || cost === FLOW_UNREACHED ? 0 : beforeCost - cost;
		const goalProgress = beforeGoalDistance - distance(movedTo, steeringTarget.finalTarget);
		const score = costProgress * 1.2 + goalProgress * 3 - direction.cost * 0.01;
		if (!best || score > best.score) best = { target, score };
	}
	return best?.target || null;
}

function movementBlocked(world: World, unit: Unit, before: Vec2) {
	return hardBlockedAlongSegment(world, unit, before, unit);
}

function canUseMovementWaypoint(world: World, unit: Unit, point: Vec2, mode: "tight" | "flow"): boolean {
	const tile = worldTile(point);
	if (!isWalkableForUnit(world, unit, tile.x, tile.y)) return false;
	if (mode === "flow") return true;
	return hasClearMovementLine(world, unit, point);
}

function canStepBetweenTiles(world: World, unit: Unit, fromX: number, fromY: number, toX: number, toY: number): boolean {
	if (!isWalkableForUnit(world, unit, toX, toY)) return false;
	if (toX !== fromX && toY !== fromY) {
		return isWalkableForUnit(world, unit, toX, fromY) && isWalkableForUnit(world, unit, fromX, toY);
	}
	return true;
}

function steeredDirection(direction: Vec2, crowdPush: Vec2, resourcePush: Vec2, mode: "tight" | "flow"): Vec2 | null {
	const x = direction.x + crowdPush.x * MOVING_UNIT_PUSH_STRENGTH + resourcePush.x * RESOURCE_CLEARANCE_STRENGTH;
	const y = direction.y + crowdPush.y * MOVING_UNIT_PUSH_STRENGTH + resourcePush.y * RESOURCE_CLEARANCE_STRENGTH;
	const length = Math.hypot(x, y);
	if (length <= 0.001) return mode === "tight" ? direction : null;
	return { x: x / length, y: y / length };
}

function steeringAngleOffsets(preferredSide: number, mode: "tight" | "flow") {
	if (mode === "tight") {
		return [0, preferredSide * 22, -preferredSide * 22, preferredSide * 45, -preferredSide * 45, preferredSide * 70, -preferredSide * 70, 180];
	}
	return [0, preferredSide * 18, -preferredSide * 18, preferredSide * 36, -preferredSide * 36, preferredSide * 58, -preferredSide * 58, preferredSide * 86, -preferredSide * 86, preferredSide * 122, -preferredSide * 122, 180];
}

function escapeOccupiedTile(world: World, unit: Unit, target: Vec2, maxStep: number): boolean {
	const tile = worldTile(unit);
	if (!isHardOccupied(world, unit, tile.x, tile.y)) return false;
	for (const direction of escapeDirections(unit, target)) {
		const before = { x: unit.x, y: unit.y };
		moveToward(unit, { x: unit.x + direction.x, y: unit.y + direction.y }, maxStep);
		const escaped = worldTile(unit);
		if (!isHardOccupied(world, unit, escaped.x, escaped.y)) return true;
		unit.x = before.x;
		unit.y = before.y;
	}
	return false;
}

function escapeDirections(from: Vec2, target: Vec2) {
	const desired = directionBetween(from, target) || { x: 1, y: 0 };
	const forward = { x: Math.round(desired.x), y: Math.round(desired.y) };
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

function movingUnitPush(world: World, unit: Unit): Vec2 {
	let pushX = 0;
	let pushY = 0;
	let neighbors = 0;
	movingUnitGrid(world).forNearby(unit, MOVING_UNIT_RADIUS, (entry) => {
		const other = entry.item;
		if (other === unit || other.ownerId !== unit.ownerId) return;
		const dx = unit.x - other.x;
		const dy = unit.y - other.y;
		const dist = Math.hypot(dx, dy);
		if (dist <= 0.001 || dist >= MOVING_UNIT_RADIUS) return;
		const strength = (MOVING_UNIT_RADIUS - dist) / MOVING_UNIT_RADIUS;
		pushX += (dx / dist) * strength;
		pushY += (dy / dist) * strength;
		neighbors += 1;
		return neighbors < MOVING_UNIT_NEIGHBORS;
	});
	return normalized(pushX, pushY);
}

function resourceClearancePush(world: World, unit: Unit): Vec2 {
	let pushX = 0;
	let pushY = 0;
	resourceGrid(world).forNearby(unit, RESOURCE_CLEARANCE_RADIUS, (entry) => {
		const resource = entry.item;
		const dx = unit.x - resource.x;
		const dy = unit.y - resource.y;
		const dist = Math.hypot(dx, dy);
		if (dist <= 0.001 || dist >= RESOURCE_CLEARANCE_RADIUS) return;
		const strength = (RESOURCE_CLEARANCE_RADIUS - dist) / RESOURCE_CLEARANCE_RADIUS;
		pushX += (dx / dist) * strength;
		pushY += (dy / dist) * strength;
	});
	return normalized(pushX, pushY);
}

function movingUnitGrid(world: World): SpatialGrid<Unit> {
	const state = pathingState(world);
	if (state.movingUnitGridTick === world.tick && state.movingUnitGrid) return state.movingUnitGrid as SpatialGrid<Unit>;
	const movingUnits = Object.values(world.units).filter((unit) => unit.type !== "zombie" && unit.hp > 0 && isMovingCommand(unit.command));
	const grid = new SpatialGrid(movingUnits, MOVING_UNIT_CELL_SIZE);
	state.movingUnitGrid = grid;
	state.movingUnitGridTick = world.tick;
	return grid;
}

function resourceGrid(world: World): SpatialGrid<ResourceNode> {
	const state = pathingState(world);
	if (state.resourceGridVersion === state.occupancyVersion && state.resourceGrid) return state.resourceGrid as SpatialGrid<ResourceNode>;
	const grid = new SpatialGrid(Object.values(world.resources), RESOURCE_CLEARANCE_RADIUS);
	state.resourceGrid = grid;
	state.resourceGridVersion = state.occupancyVersion;
	return grid;
}

function isMovingCommand(command: UnitCommand): boolean {
	if (command.type === "move") return true;
	if ((command.type === "attack" || command.type === "gather" || command.type === "build") && command.path && command.path.length > 0) return true;
	return false;
}

function interactionFlowField(world: World, unit: Unit, target: Vec2, range: number): FlowField {
	const goals = interactionGoalIds(world, unit, target, range);
	return multiGoalFlowField(world, unit, goals, `player-interaction:${unit.ownerId}:${ownGateSignature(world)}:${worldTile(target).x},${worldTile(target).y}:${Math.ceil(range * 10)}`);
}

function interactionGoalIds(world: World, unit: Unit, target: Vec2, range: number): number[] {
	const origin = worldTile(target);
	const searchRadius = Math.max(1, Math.ceil(range) + INTERACTION_GOAL_PADDING);
	const goals: number[] = [];
	for (let y = origin.y - searchRadius; y <= origin.y + searchRadius; y += 1) {
		for (let x = origin.x - searchRadius; x <= origin.x + searchRadius; x += 1) {
			if (!isWalkableForUnit(world, unit, x, y)) continue;
			if (distance(tileCenter({ x, y }), target) > range) continue;
			goals.push(tileId(x, y));
		}
	}
	if (goals.length > 0) return goals;
	const nearest = nearestWalkableAround(world, target, unit);
	return [tileId(nearest.x, nearest.y)];
}

function flowField(world: World, unit: Unit, goal: { x: number; y: number }, clearancePenalty: number): FlowField {
	const goalId = tileId(goal.x, goal.y);
	return multiGoalFlowField(world, unit, [goalId], `player:${unit.ownerId}:${ownGateSignature(world)}:${goalId}:${clearancePenalty}`, clearancePenalty);
}

function multiGoalFlowField(world: World, unit: Unit, goals: number[], cacheKeyParts: string, clearancePenalty = 0): FlowField {
	const state = pathingState(world);
	const cacheKey = `${state.occupancyVersion}:${cacheKeyParts}`;
	const cached = state.flowFields.get(cacheKey) as FlowField | undefined;
	if (cached && world.tick - cached.createdTick <= FLOW_CACHE_TICKS) return cached;
	const field = buildFlowField(world, unit, goals, clearancePenalty);
	state.flowFields.set(cacheKey, field);
	if (state.flowFields.size > FLOW_CACHE_LIMIT) pruneFlowFields(state.flowFields as Map<string, FlowField>, world.tick);
	return field;
}

function buildFlowField(world: World, unit: Unit, goals: number[], clearancePenalty: number): FlowField {
	const distanceGrid = new Uint32Array(MAP_SIZE * MAP_SIZE);
	distanceGrid.fill(FLOW_UNREACHED);
	const next = new Int32Array(MAP_SIZE * MAP_SIZE);
	next.fill(-1);
	const open = new MinPriorityQueue<{ id: number; cost: number }>((node) => node.cost);
	for (const goal of goals) {
		if (goal < 0 || goal >= MAP_SIZE * MAP_SIZE) continue;
		const x = goal % MAP_SIZE;
		const y = Math.floor(goal / MAP_SIZE);
		if (!isWalkableForUnit(world, unit, x, y)) continue;
		distanceGrid[goal] = 0;
		next[goal] = goal;
		open.push({ id: goal, cost: 0 });
	}
	const goalId = goals.find((goal) => goal >= 0) ?? -1;
	while (open.length) {
		const currentNode = open.pop()!;
		const current = currentNode.id;
		if (currentNode.cost !== distanceGrid[current]) continue;
		const x = current % MAP_SIZE;
		const y = Math.floor(current / MAP_SIZE);
		for (const direction of FLOW_DIRECTIONS) {
			touchFlowNeighbor(world, unit, distanceGrid, next, open, current, x + direction.x, y + direction.y, direction.cost, clearancePenalty);
		}
	}
	return { goalId, createdTick: world.tick, distance: distanceGrid, next };
}

function touchFlowNeighbor(
	world: World,
	unit: Unit,
	distanceGrid: Uint32Array,
	next: Int32Array,
	open: MinPriorityQueue<{ id: number; cost: number }>,
	current: number,
	x: number,
	y: number,
	stepCost: number,
	clearancePenalty: number,
) {
	if (!isWalkableForUnit(world, unit, x, y)) return;
	const currentX = current % MAP_SIZE;
	const currentY = Math.floor(current / MAP_SIZE);
	if (x !== currentX && y !== currentY && (!isWalkableForUnit(world, unit, x, currentY) || !isWalkableForUnit(world, unit, currentX, y))) return;
	const id = tileId(x, y);
	const nextDistance = distanceGrid[current]! + stepCost + obstaclePenalty(world, x, y, clearancePenalty);
	if (nextDistance >= distanceGrid[id]!) return;
	distanceGrid[id] = nextDistance;
	next[id] = current;
	open.push({ id, cost: nextDistance });
}

const FLOW_DIRECTIONS = [
	{ x: 1, y: 0, cost: FLOW_BASE_COST },
	{ x: -1, y: 0, cost: FLOW_BASE_COST },
	{ x: 0, y: 1, cost: FLOW_BASE_COST },
	{ x: 0, y: -1, cost: FLOW_BASE_COST },
	{ x: 1, y: 1, cost: FLOW_DIAGONAL_COST },
	{ x: 1, y: -1, cost: FLOW_DIAGONAL_COST },
	{ x: -1, y: 1, cost: FLOW_DIAGONAL_COST },
	{ x: -1, y: -1, cost: FLOW_DIAGONAL_COST },
] as const;

function bestFlowStep(world: World, unit: Unit, field: FlowField, current: number): number {
	const x = current % MAP_SIZE;
	const y = Math.floor(current / MAP_SIZE);
	let best = field.next[current]!;
	let bestDistance = best >= 0 ? field.distance[best]! : FLOW_UNREACHED;
	for (const direction of FLOW_DIRECTIONS) {
		const nx = x + direction.x;
		const ny = y + direction.y;
		if (!isWalkableForUnit(world, unit, nx, ny)) continue;
		if (direction.x !== 0 && direction.y !== 0 && (!isWalkableForUnit(world, unit, nx, y) || !isWalkableForUnit(world, unit, x, ny))) continue;
		const id = tileId(nx, ny);
		const d = field.distance[id]!;
		if (d < bestDistance) {
			best = id;
			bestDistance = d;
		}
	}
	return best;
}

function nearestReachablePointToward(world: World, unit: Unit, field: FlowField, target: Vec2): Vec2 {
	const start = worldTile(unit);
	let best = nearestWalkableAround(world, unit, unit);
	let bestScore = Infinity;
	for (let radius = 1; radius <= NEAREST_WALKABLE_RADIUS; radius += 1) {
		for (let y = start.y - radius; y <= start.y + radius; y += 1) {
			for (let x = start.x - radius; x <= start.x + radius; x += 1) {
				if (Math.abs(x - start.x) !== radius && Math.abs(y - start.y) !== radius) continue;
				if (!isWalkableForUnit(world, unit, x, y)) continue;
				const id = tileId(x, y);
				const fieldDistance = field.distance[id]!;
				if (fieldDistance === FLOW_UNREACHED) continue;
				const center = tileCenter({ x, y });
				const score = distance(unit, center) * 2 + distance(center, target) + fieldDistance * 0.02;
				if (score < bestScore) {
					best = { x, y };
					bestScore = score;
				}
			}
		}
		if (bestScore < Infinity) return tileCenter(best);
	}
	return nearestWalkablePointAround(world, target, unit);
}

function obstaclePenalty(world: World, x: number, y: number, clearancePenalty: number): number {
	if (clearancePenalty <= 0) return 0;
	let blockedNeighbors = 0;
	for (let dy = -1; dy <= 1; dy += 1) {
		for (let dx = -1; dx <= 1; dx += 1) {
			if (dx === 0 && dy === 0) continue;
			if (occupied(world, x + dx, y + dy)) blockedNeighbors += 1;
		}
	}
	return blockedNeighbors * clearancePenalty;
}

function clearancePenaltyForCrowd(crowd: number): number {
	if (crowd >= 500) return 18;
	if (crowd >= 220) return 14;
	if (crowd >= 80) return 10;
	if (crowd >= 28) return 7;
	if (crowd >= 12) return 4;
	return 0;
}

function isMoveComplete(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2, finalTarget: Vec2): boolean {
	if (!command.formationTarget) return isAccessibleArrival(world, unit, baseTarget, arrivalRadius(command));
	if (isAccessibleArrival(world, unit, finalTarget, FORMATION_SLOT_SETTLE_RADIUS)) return true;
	return isAccessibleArrival(world, unit, baseTarget, arrivalRadius(command)) && isAccessibleArrival(world, unit, finalTarget, FORMATION_SLOT_PRACTICAL_SETTLE_RADIUS);
}

function isPracticalGroupComplete(world: World, unit: Unit, command: Extract<UnitCommand, { type: "move" }>, baseTarget: Vec2, finalTarget: Vec2, movedDistance: number, finalProgress: number): boolean {
	if (!isAccessibleArrival(world, unit, baseTarget, arrivalRadius(command))) {
		command.moveStuckTicks = 0;
		delete command.moveBestDistance;
		return false;
	}
	if (!command.formationTarget) return movedDistance < STUCK_MOVEMENT_EPSILON;
	if (isAccessibleArrival(world, unit, finalTarget, FORMATION_SLOT_PRACTICAL_SETTLE_RADIUS)) return true;
	const closeSettle = closeFormationSettleState(unit, command, finalTarget, finalProgress);
	if (closeSettle !== "open") return closeSettle === "settled";
	if (movedDistance >= STUCK_MOVEMENT_EPSILON) {
		command.moveStuckTicks = 0;
		delete command.moveBestDistance;
		return false;
	}
	command.moveStuckTicks = (command.moveStuckTicks || 0) + 1;
	return command.moveStuckTicks >= (commandCrowd(command) >= 20 ? 2 : 4);
}

function closeFormationSettleState(unit: Unit, command: Extract<UnitCommand, { type: "move" }>, finalTarget: Vec2, finalProgress: number): "open" | "waiting" | "settled" {
	const finalDistance = distance(unit, finalTarget);
	if (finalDistance > FORMATION_SLOT_CLOSE_SETTLE_RADIUS) {
		delete command.moveBestDistance;
		return "open";
	}
	const bestDistance = command.moveBestDistance ?? Infinity;
	if (finalDistance + 0.04 < bestDistance) {
		command.moveBestDistance = finalDistance;
		command.moveStuckTicks = 0;
		return "waiting";
	}
	if (finalProgress > 0.03) return "waiting";
	command.moveStuckTicks = (command.moveStuckTicks || 0) + 1;
	return command.moveStuckTicks >= FORMATION_SLOT_CLOSE_STUCK_TICKS ? "settled" : "waiting";
}

function isAccessibleArrival(world: World, unit: Unit, target: Vec2, radius: number): boolean {
	if (distance(unit, target) > radius) return false;
	return hasClearMovementLine(world, unit, target);
}

function arrivalRadius(command: UnitCommand): number {
	return Math.min(GROUP_ARRIVAL_MAX_RADIUS, GROUP_ARRIVAL_BASE_RADIUS + Math.sqrt(commandCrowd(command)) * 0.32);
}

function formationDeployRadius(command: UnitCommand): number {
	return Math.min(FORMATION_DEPLOY_MAX_RADIUS, Math.max(arrivalRadius(command) + 2, Math.sqrt(commandCrowd(command)) * 1.05));
}

function commandCrowd(command: UnitCommand): number {
	return Math.max(1, command.pathCrowd || 1);
}

function pathFollowMode(command: UnitCommand): "tight" | "flow" {
	if (commandCrowd(command) <= 1) return "tight";
	return "flow";
}

function updateMovePathDebug(world: World, command: UnitCommand, target: SteeringTarget) {
	command.path = hasPathDebugViewer(world) ? debugPathFromTarget(target) : null;
}

function trackInteractionProgress(
	world: World,
	unit: Unit,
	command: UnitCommand,
	target: Vec2,
	range: number,
	field: FlowField,
	beforeDistance: number,
	afterDistance: number,
	arrived: boolean,
) {
	if (arrived) {
		resetInteractionProgress(command);
		return;
	}
	const key = interactionProgressKey(target, range);
	if (command.interactionTargetKey !== key) {
		command.interactionTargetKey = key;
		delete command.interactionBestCost;
		command.moveStuckTicks = 0;
	}
	const currentCost = interactionProgressCost(world, unit, field, afterDistance);
	if (command.interactionBestCost === undefined || currentCost + INTERACTION_PROGRESS_EPSILON < command.interactionBestCost) {
		command.interactionBestCost = currentCost;
		command.moveStuckTicks = 0;
		return;
	}
	command.moveStuckTicks = (command.moveStuckTicks || 0) + 1;
}

function interactionProgressCost(world: World, unit: Unit, field: FlowField, fallbackDistance: number): number {
	const cost = flowCostAt(world, field, unit);
	if (cost !== FLOW_UNREACHED) return cost + fallbackDistance;
	return Math.ceil(fallbackDistance * FLOW_BASE_COST);
}

function interactionProgressKey(target: Vec2, range: number): string {
	const tile = worldTile(target);
	return `${tile.x},${tile.y}:${Math.ceil(range * 10)}`;
}

function resetInteractionProgress(command: UnitCommand) {
	command.moveStuckTicks = 0;
	delete command.interactionBestCost;
	delete command.interactionTargetKey;
}

function isPracticalInteractionComplete(command: UnitCommand, distanceToTarget: number, range: number): boolean {
	if ((command.moveStuckTicks || 0) < INTERACTION_PRACTICAL_STUCK_TICKS) return false;
	return distanceToTarget <= range + INTERACTION_PRACTICAL_PADDING;
}

function debugPathFromTarget(target: SteeringTarget): PathNode[] | null {
	if (!target.field) return [{ x: target.base.x, y: target.base.y }];
	return [{ x: target.base.x, y: target.base.y }, { x: target.finalTarget.x, y: target.finalTarget.y }];
}

function hasPathDebugViewer(world: World): boolean {
	const state = pathingState(world);
	if (state.pathDebugViewerTick === world.tick && state.pathDebugViewer !== undefined) return state.pathDebugViewer;
	const enabled = Object.values(world.players).some((player) => player.pathDebug === true);
	state.pathDebugViewer = enabled;
	state.pathDebugViewerTick = world.tick;
	return enabled;
}

function nearestWalkablePointAround(world: World, target: Vec2, unit: Unit): Vec2 {
	return tileCenter(nearestWalkableAround(world, target, unit));
}

function nearestWalkableAround(world: World, target: Vec2, unit: Unit) {
	const origin = worldTile(target);
	if (isWalkableForUnit(world, unit, origin.x, origin.y)) return origin;
	let best = origin;
	let bestDistance = Infinity;
	for (let radius = 1; radius <= NEAREST_WALKABLE_RADIUS; radius += 1) {
		for (let y = origin.y - radius; y <= origin.y + radius; y += 1) {
			for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
				if (Math.abs(x - origin.x) !== radius && Math.abs(y - origin.y) !== radius) continue;
				if (!isWalkableForUnit(world, unit, x, y)) continue;
				const d = Math.hypot(x - target.x, y - target.y);
				if (d < bestDistance) {
					best = { x, y };
					bestDistance = d;
				}
			}
		}
		if (bestDistance < Infinity) return best;
	}
	return {
		x: clamp(origin.x, 0, MAP_SIZE - 1),
		y: clamp(origin.y, 0, MAP_SIZE - 1),
	};
}

function hasClearMovementLine(world: World, unit: Unit, point: Vec2): boolean {
	const cache = clearMovementLineCache(world);
	const cacheKey = clearMovementLineCacheKey(unit, point);
	const cached = cache.get(cacheKey);
	if (cached !== undefined) return cached;
	const dx = point.x - unit.x;
	const dy = point.y - unit.y;
	const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / CLEAR_LINE_SAMPLE_STEP));
	let previousTile = worldTile(unit);
	for (let i = 1; i <= steps; i += 1) {
		const x = unit.x + (dx * i) / steps;
		const y = unit.y + (dy * i) / steps;
		const tile = worldTile({ x, y });
		if (!isWalkableForUnit(world, unit, tile.x, tile.y) || !canStepBetweenTiles(world, unit, previousTile.x, previousTile.y, tile.x, tile.y)) {
			cache.set(cacheKey, false);
			return false;
		}
		previousTile = tile;
	}
	cache.set(cacheKey, true);
	return true;
}

function hardBlockedAlongSegment(world: World, unit: Unit, from: Vec2, to: Vec2): boolean {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / CLEAR_LINE_SAMPLE_STEP));
	let previousTile = worldTile(from);
	for (let i = 1; i <= steps; i += 1) {
		const point = {
			x: from.x + (dx * i) / steps,
			y: from.y + (dy * i) / steps,
		};
		const tile = worldTile(point);
		if (isHardOccupied(world, unit, tile.x, tile.y)) return true;
		if (!canStepBetweenTiles(world, unit, previousTile.x, previousTile.y, tile.x, tile.y)) return true;
		previousTile = tile;
	}
	return false;
}

function clearMovementLineCacheKey(unit: Unit, point: Vec2): string {
	const unitTile = worldTile(unit);
	const pointTile = worldTile(point);
	return `player:${unit.ownerId}:${unitTile.x},${unitTile.y}:${pointTile.x},${pointTile.y}`;
}

function clearMovementLineCache(world: World): Map<string, boolean> {
	const state = pathingState(world);
	if (state.clearMovementLineCacheTick === world.tick && state.clearMovementLineCache) return state.clearMovementLineCache;
	state.clearMovementLineCache = new Map();
	state.clearMovementLineCacheTick = world.tick;
	return state.clearMovementLineCache;
}

function isHardOccupied(world: World, unit: Unit, x: number, y: number): boolean {
	if (!occupied(world, x, y)) return false;
	if (isOwnGateTile(world, unit, x, y)) return false;
	return true;
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
	return ownGateTiles(world).get(unit.ownerId)?.has(tileId(x, y)) ?? false;
}

function ownGateTiles(world: World): Map<string, Set<number>> {
	const state = pathingState(world);
	if (
		state.ownGateTilesVersion === state.occupancyVersion &&
		state.ownGateTilesTick === world.tick &&
		state.ownGateTiles
	) {
		return state.ownGateTiles;
	}
	const gates = new Map<string, Set<number>>();
	for (const building of Object.values(world.buildings)) {
		if (building.type !== "gate" || building.hp <= 0) continue;
		let tiles = gates.get(building.ownerId);
		if (!tiles) {
			tiles = new Set();
			gates.set(building.ownerId, tiles);
		}
		for (let dy = 0; dy < building.height; dy += 1) {
			for (let dx = 0; dx < building.width; dx += 1) {
				const x = building.x + dx;
				const y = building.y + dy;
				if (isInMap(x, y)) tiles.add(tileId(x, y));
			}
		}
	}
	state.ownGateTiles = gates;
	state.ownGateTilesVersion = state.occupancyVersion;
	state.ownGateTilesTick = world.tick;
	return gates;
}

function ownGateSignature(world: World): string {
	const state = pathingState(world);
	if (state.ownGateSignatureTick === world.tick && state.ownGateSignature !== undefined) return state.ownGateSignature;
	const gates = Object.values(world.buildings)
		.filter((building) => building.type === "gate" && building.hp > 0)
		.map((building) => `${building.ownerId}:${building.x},${building.y},${building.width},${building.height}`)
		.sort()
		.join("|");
	state.ownGateSignature = gates;
	state.ownGateSignatureTick = world.tick;
	return gates;
}

function pruneFlowFields(fields: Map<string, FlowField>, tick: number) {
	for (const [key, field] of fields) {
		if (tick - field.createdTick > FLOW_CACHE_TICKS) fields.delete(key);
	}
	if (fields.size <= FLOW_CACHE_LIMIT) return;
	for (const key of fields.keys()) {
		fields.delete(key);
		if (fields.size <= FLOW_CACHE_LIMIT * 0.75) return;
	}
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

function flowCostAt(world: World, field: FlowField | null, point: Vec2): number {
	if (!field) return 0;
	const tile = worldTile(point);
	if (!isInMap(tile.x, tile.y)) return FLOW_UNREACHED;
	return field.distance[tileId(tile.x, tile.y)]!;
}

function unitLane(unit: Unit, crowd: number): number {
	const lanes = movementLanesForCrowd(crowd);
	return (unitHash(unit.id) % lanes) - Math.floor(lanes / 2);
}

function movementLanesForCrowd(crowd: number): number {
	if (crowd >= 1000) return 23;
	if (crowd >= 500) return 21;
	if (crowd >= 220) return 17;
	if (crowd >= 120) return 15;
	if (crowd >= 70) return 13;
	if (crowd >= 35) return 11;
	if (crowd >= 16) return 9;
	return 5;
}

function laneWidth(crowd: number): number {
	if (crowd >= 500) return 0.36;
	if (crowd >= 120) return 0.32;
	if (crowd >= 35) return 0.28;
	if (crowd >= 8) return 0.24;
	return 0.2;
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

function normalized(x: number, y: number): Vec2 {
	const length = Math.hypot(x, y);
	if (length <= 0.001) return { x: 0, y: 0 };
	return { x: x / length, y: y / length };
}

function unitHash(idValue: string): number {
	let hash = 0;
	for (let i = 0; i < idValue.length; i += 1) hash = (hash * 31 + idValue.charCodeAt(i)) | 0;
	return Math.abs(hash);
}

function tileCenter(tile: { x: number; y: number }): Vec2 {
	return { x: tile.x + 0.5, y: tile.y + 0.5 };
}

function tileCenterById(id: number): Vec2 {
	return tileCenter({ x: id % MAP_SIZE, y: Math.floor(id / MAP_SIZE) });
}

function worldTile(point: Vec2): { x: number; y: number } {
	return {
		x: clamp(Math.floor(point.x), 0, MAP_SIZE - 1),
		y: clamp(Math.floor(point.y), 0, MAP_SIZE - 1),
	};
}

function tileId(x: number, y: number): number {
	return y * MAP_SIZE + x;
}

function isInMap(x: number, y: number) {
	return x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE;
}
