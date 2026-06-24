import { BUILDING_TYPES } from "../../src/shared/buildings/index.js";
import type { BuildingType, ResourceType } from "../../src/shared/types.js";
import type { GameState, ViewState } from "./clientTypes.js";

type Footprint = {
	width: number;
	height: number;
};

type RectEntity = {
	x: number;
	y: number;
	size?: number;
	width?: number;
	height?: number;
};

export class BuildPlacement {
	constructor(
		private readonly state: GameState,
		private readonly view: ViewState,
	) {}

	canAfford(cost: Partial<Record<ResourceType, number>> = {}) {
		const resources: Record<string, number> = this.state.snapshot?.players[this.state.playerId!]?.resources || {};
		return Object.entries(cost).every(([resource, amount]) => (resources[resource] || 0) >= (amount as number));
	}

	canAffordBuildAt(buildingType: BuildingType, x: number, y: number) {
		return this.canAfford(this.effectiveBuildCost(buildingType, x, y));
	}

	effectiveBuildCost(buildingType: BuildingType, x: number, y: number) {
		const cost = { ...(BUILDING_TYPES[buildingType as keyof typeof BUILDING_TYPES]?.cost || {}) } as Partial<Record<ResourceType, number>>;
		const wall = this.ownWallAt(x, y);
		if (buildingType !== "gate" || !wall || wall.completed) return cost;
		for (const [resource, amount] of Object.entries(BUILDING_TYPES.wall.cost) as [ResourceType, number][]) {
			cost[resource] = Math.max(0, (cost[resource] || 0) - amount);
		}
		return cost;
	}

	canAffordLine(buildingType: BuildingType, tiles: { x: number; y: number }[]) {
		const cost = BUILDING_TYPES[buildingType as keyof typeof BUILDING_TYPES]?.cost || {};
		const multiplier = tiles.filter((tile) => !this.ownWallAt(tile.x, tile.y)).length;
		const total = Object.fromEntries(Object.entries(cost).map(([resource, amount]) => [resource, (amount as number) * multiplier])) as Partial<Record<ResourceType, number>>;
		return this.canAfford(total);
	}

	wallLineTiles() {
		if (!this.view.wallDragStartTile || !this.view.hoverTile) return [];
		const start = this.view.wallDragStartTile;
		const end = this.view.hoverTile;
		const axis = this.closestWallAxis(start, end);
		const length = Math.max(0, Math.round(axis.length));
		const tiles: { x: number; y: number }[] = [];
		for (let index = 0; index <= length; index += 1) {
			tiles.push({ x: start.x + axis.dx * index, y: start.y + axis.dy * index });
		}
		return tiles;
	}

	canPlacePreview(buildingType: BuildingType, x: number, y: number) {
		if (!this.state.snapshot || !BUILDING_TYPES[buildingType as keyof typeof BUILDING_TYPES]) return false;
		const footprint = this.buildingFootprint(buildingType);
		const replacementWall = this.ownWallAt(x, y);
		if (buildingType === "wall" && replacementWall) return true;
		if (x < 0 || y < 0 || x + footprint.width > this.state.snapshot.map.size || y + footprint.height > this.state.snapshot.map.size) return false;
		for (const building of Object.values(this.state.snapshot.buildings)) {
			if (buildingType === "gate" && replacementWall && building.id === replacementWall.id) continue;
			if (this.rectsOverlap({ x, y, ...footprint }, building)) return false;
		}
		for (const resource of Object.values(this.state.snapshot.resources)) {
			if (this.pointInFootprint(Math.floor(resource.x), Math.floor(resource.y), x, y, footprint)) return false;
		}
		for (const corpse of Object.values(this.state.snapshot.corpses)) {
			if (this.pointInFootprint(Math.floor(corpse.x), Math.floor(corpse.y), x, y, footprint)) return false;
		}
		return true;
	}

	ownWallAt(x: number, y: number) {
		return Object.values(this.state.snapshot?.buildings || {}).find((building) => (
			building.ownerId === this.state.playerId &&
			building.type === "wall" &&
			building.x === x &&
			building.y === y
		)) || null;
	}

	private closestWallAxis(start: { x: number; y: number }, end: { x: number; y: number }) {
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const axes = [
			{ dx: dx >= 0 ? 1 : -1, dy: 0, length: Math.abs(dx), distance: Math.abs(dy) },
			{ dx: 0, dy: dy >= 0 ? 1 : -1, length: Math.abs(dy), distance: Math.abs(dx) },
			{ dx: dx - dy >= 0 ? 1 : -1, dy: dx - dy >= 0 ? -1 : 1, length: Math.abs(dx - dy) / 2, distance: Math.abs(dx + dy) },
			{ dx: dx + dy >= 0 ? 1 : -1, dy: dx + dy >= 0 ? 1 : -1, length: Math.abs(dx + dy) / 2, distance: Math.abs(dx - dy) },
		];
		return axes.sort((a, b) => a.distance - b.distance || b.length - a.length)[0]!;
	}

	private buildingSize(type: BuildingType) {
		if (type in BUILDING_TYPES) return BUILDING_TYPES[type as keyof typeof BUILDING_TYPES].size;
		if (type === "barracks") return 3;
		if (type === "house") return 2;
		return 1;
	}

	private buildingFootprint(type: BuildingType): Footprint {
		const def = BUILDING_TYPES[type as keyof typeof BUILDING_TYPES];
		const size = this.buildingSize(type);
		return {
			width: (def && "width" in def ? def.width : size) as number,
			height: (def && "height" in def ? def.height : size) as number,
		};
	}

	private rectsOverlap(a: RectEntity, b: RectEntity) {
		const aw = a.width ?? a.size ?? 1;
		const ah = a.height ?? a.size ?? 1;
		const bw = b.width ?? b.size ?? 1;
		const bh = b.height ?? b.size ?? 1;
		return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
	}

	private pointInFootprint(px: number, py: number, x: number, y: number, footprint: Footprint) {
		return px >= x && px < x + footprint.width && py >= y && py < y + footprint.height;
	}
}
