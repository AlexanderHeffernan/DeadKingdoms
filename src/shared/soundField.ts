import { MAP_SIZE } from "./config.js";
import type { Vec2, World } from "./types.js";
import { unitBehaviorFor } from "./unitRegistry.js";

export const SOUND_FIELD_CELL_SIZE = 8;
export const SOUND_FIELD_MAX_STRENGTH = 8;
export const SOUND_FIELD_OVERFLOW_DECAY = 0.55;
export const SOUND_FIELD_OVERFLOW_KNEE = 3000;
export const SOUND_FIELD_MIN_SPREAD_STRENGTH = 0.25;

export type SoundSourceKind = "unit" | "building" | "action" | "zombie";

export interface SoundFieldSource extends Vec2 {
	id: string;
	kind: SoundSourceKind;
	label: string;
	strength: number;
	hordeId?: string | null | undefined;
}

export interface SoundFieldCell extends Vec2 {
	id: string;
	cellX: number;
	cellY: number;
	strength: number;
	rawStrength: number;
	sourceCount: number;
	overflow: boolean;
	worldStrength: number;
	zombieStrength: number;
	hordeIds: string[];
	zombieStrengthByHorde: Record<string, number>;
}

type MutableSoundCell = SoundFieldCell & {
	weight: number;
	hordeIdSet: Set<string>;
	zombieStrengthByHordeMap: Map<string, number>;
};

type SoundSourceOptions = {
	includeZombies?: boolean;
};

export function collectWorldSoundSources(world: World, zombieOwnerId: string, options: SoundSourceOptions = {}): SoundFieldSource[] {
	const sources: SoundFieldSource[] = [];
	for (const unit of Object.values(world.units)) {
		if (unit.hp <= 0) continue;
		if (unit.ownerId === zombieOwnerId && !options.includeZombies) continue;
		const strength = unitBehaviorFor(unit.type).soundLevel();
		if (strength > 0) {
			const isZombie = unit.ownerId === zombieOwnerId;
			sources.push({
				id: unit.id,
				kind: isZombie ? "zombie" : "unit",
				label: unit.type,
				x: unit.x,
				y: unit.y,
				strength,
				hordeId: isZombie ? unit.hordeId : null,
			});
		}
	}
	for (const building of Object.values(world.buildings)) {
		const strength = building.soundLevel();
		if (strength > 0) sources.push({ id: building.id, kind: "building", label: building.type, ...centerOf(building), strength });
	}
	for (const noise of world.actionNoises) {
		if (noise.sound > 0) sources.push({ id: noise.id, kind: "action", label: noise.action, x: noise.x, y: noise.y, strength: noise.sound });
	}
	return sources;
}

export function buildSoundField(sources: SoundFieldSource[]): SoundFieldCell[] {
	const cells = new Map<string, MutableSoundCell>();
	for (const source of sources) addSourceToCell(cells, source);
	for (const cell of [...cells.values()]) spreadOverflow(cells, cell);
	return [...cells.values()]
		.filter((cell) => cell.strength > 0)
		.map((cell) => ({
			id: cell.id,
			cellX: cell.cellX,
			cellY: cell.cellY,
			x: cell.x,
			y: cell.y,
			strength: cell.strength,
			rawStrength: cell.rawStrength,
			sourceCount: cell.sourceCount,
			overflow: cell.overflow,
			worldStrength: cell.worldStrength,
			zombieStrength: cell.zombieStrength,
			hordeIds: [...cell.hordeIdSet],
			zombieStrengthByHorde: Object.fromEntries(cell.zombieStrengthByHordeMap),
		}));
}

export function soundFieldCellAt(cells: SoundFieldCell[], point: Vec2): SoundFieldCell | null {
	const id = cellId(cellCoord(point.x), cellCoord(point.y));
	return cells.find((cell) => cell.id === id) || null;
}

function addSourceToCell(cells: Map<string, MutableSoundCell>, source: SoundFieldSource) {
	const cellX = cellCoord(source.x);
	const cellY = cellCoord(source.y);
	const cell = getCell(cells, cellX, cellY);
	applyContribution(cell, source.x, source.y, source.strength, source.strength, false, 1, source);
}

function spreadOverflow(cells: Map<string, MutableSoundCell>, cell: MutableSoundCell) {
	const overflowStrength = overflowSpreadStrength(cell.rawStrength);
	if (overflowStrength <= 0) return;
	const queue = [{ cellX: cell.cellX, cellY: cell.cellY, strength: overflowStrength }];
	const best = new Map<string, number>([[cell.id, overflowStrength]]);
	for (let index = 0; index < queue.length; index += 1) {
		const current = queue[index]!;
		if (current.strength < SOUND_FIELD_MIN_SPREAD_STRENGTH) continue;
		for (const neighbor of neighboringCells(current.cellX, current.cellY)) {
			const id = cellId(neighbor.x, neighbor.y);
			if ((best.get(id) || 0) >= current.strength) continue;
			best.set(id, current.strength);
			applyContribution(getCell(cells, neighbor.x, neighbor.y), cell.x, cell.y, current.strength, 0, true, 0, cell);
			queue.push({
				cellX: neighbor.x,
				cellY: neighbor.y,
				strength: current.strength * SOUND_FIELD_OVERFLOW_DECAY,
			});
		}
	}
}

function overflowSpreadStrength(rawStrength: number): number {
	const excess = Math.max(0, rawStrength - SOUND_FIELD_MAX_STRENGTH);
	if (excess <= 0) return 0;
	const softenedExcess = (excess * excess) / (excess + SOUND_FIELD_OVERFLOW_KNEE);
	return softenedExcess * SOUND_FIELD_OVERFLOW_DECAY;
}

function applyContribution(
	cell: MutableSoundCell,
	x: number,
	y: number,
	strength: number,
	rawStrength: number,
	overflow: boolean,
	sourceCount: number,
	source: SoundFieldSource | MutableSoundCell,
) {
	const previousWeight = cell.weight;
	const nextWeight = previousWeight + strength;
	cell.x = nextWeight > 0 ? (cell.x * previousWeight + x * strength) / nextWeight : cellCenter(cell.cellX);
	cell.y = nextWeight > 0 ? (cell.y * previousWeight + y * strength) / nextWeight : cellCenter(cell.cellY);
	cell.weight = nextWeight;
	cell.rawStrength += rawStrength;
	cell.strength = Math.min(SOUND_FIELD_MAX_STRENGTH, cell.strength + strength);
	cell.sourceCount += sourceCount;
	cell.overflow ||= overflow;
	if ("hordeIdSet" in source) {
		const mixedStrength = source.worldStrength + source.zombieStrength || 1;
		cell.worldStrength = Math.min(SOUND_FIELD_MAX_STRENGTH, cell.worldStrength + strength * (source.worldStrength / mixedStrength));
		cell.zombieStrength = Math.min(SOUND_FIELD_MAX_STRENGTH, cell.zombieStrength + strength * (source.zombieStrength / mixedStrength));
		for (const hordeId of source.hordeIdSet) cell.hordeIdSet.add(hordeId);
		for (const [hordeId, hordeStrength] of source.zombieStrengthByHordeMap) {
			const contribution = strength * (hordeStrength / mixedStrength);
			cell.zombieStrengthByHordeMap.set(hordeId, Math.min(SOUND_FIELD_MAX_STRENGTH, (cell.zombieStrengthByHordeMap.get(hordeId) || 0) + contribution));
		}
	} else if (source.kind === "zombie") {
		cell.zombieStrength = Math.min(SOUND_FIELD_MAX_STRENGTH, cell.zombieStrength + strength);
		if (source.hordeId) {
			cell.hordeIdSet.add(source.hordeId);
			cell.zombieStrengthByHordeMap.set(source.hordeId, Math.min(SOUND_FIELD_MAX_STRENGTH, (cell.zombieStrengthByHordeMap.get(source.hordeId) || 0) + strength));
		}
	} else {
		cell.worldStrength = Math.min(SOUND_FIELD_MAX_STRENGTH, cell.worldStrength + strength);
	}
}

function getCell(cells: Map<string, MutableSoundCell>, cellX: number, cellY: number) {
	const id = cellId(cellX, cellY);
	let cell = cells.get(id);
	if (cell) return cell;
	cell = {
		id,
		cellX,
		cellY,
		x: cellCenter(cellX),
		y: cellCenter(cellY),
		strength: 0,
		rawStrength: 0,
		sourceCount: 0,
		overflow: false,
		worldStrength: 0,
		zombieStrength: 0,
		hordeIds: [],
		zombieStrengthByHorde: {},
		weight: 0,
		hordeIdSet: new Set(),
		zombieStrengthByHordeMap: new Map(),
	};
	cells.set(id, cell);
	return cell;
}

function centerOf(entity: { x: number; y: number; size?: number; width?: number; height?: number }): Vec2 {
	const width = entity.width ?? entity.size ?? 1;
	const height = entity.height ?? entity.size ?? 1;
	return { x: entity.x + (width - 1) / 2, y: entity.y + (height - 1) / 2 };
}

function cellCoord(value: number) {
	return Math.max(0, Math.min(cellCount() - 1, Math.floor(value / SOUND_FIELD_CELL_SIZE)));
}

function cellCenter(coord: number) {
	return Math.min(MAP_SIZE - 0.5, coord * SOUND_FIELD_CELL_SIZE + SOUND_FIELD_CELL_SIZE / 2);
}

function cellCount() {
	return Math.ceil(MAP_SIZE / SOUND_FIELD_CELL_SIZE);
}

function isCellInMap(x: number, y: number) {
	return x >= 0 && y >= 0 && x < cellCount() && y < cellCount();
}

function neighboringCells(cellX: number, cellY: number) {
	const cells = [];
	for (let dy = -1; dy <= 1; dy += 1) {
		for (let dx = -1; dx <= 1; dx += 1) {
			if (dx === 0 && dy === 0) continue;
			const x = cellX + dx;
			const y = cellY + dy;
			if (isCellInMap(x, y)) cells.push({ x, y });
		}
	}
	return cells;
}

function cellId(x: number, y: number) {
	return `${x},${y}`;
}
