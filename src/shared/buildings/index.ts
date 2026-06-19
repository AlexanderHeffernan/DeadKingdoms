import { Barracks } from "./definitions/Barracks.js";
import { Farm } from "./definitions/Farm.js";
import { FoodDepot } from "./definitions/FoodDepot.js";
import { Gate } from "./definitions/Gate.js";
import { House } from "./definitions/House.js";
import { LumberCamp } from "./definitions/LumberCamp.js";
import { MiningCamp } from "./definitions/MiningCamp.js";
import { TownCenter } from "./definitions/TownCenter.js";
import { WatchTower } from "./definitions/WatchTower.js";
import { Wall } from "./definitions/Wall.js";
import type { BuildingConstructor, BuildingEntity, BuildingInit, BuildingSnapshot } from "./base/index.js";
import type { BuildingType } from "../types.js";

export { Barracks, Farm, FoodDepot, Gate, House, LumberCamp, MiningCamp, TownCenter, Wall, WatchTower };

export const BUILDING_TYPES = {
	townCenter: TownCenter,
	house: House,
	barracks: Barracks,
	watchTower: WatchTower,
	wall: Wall,
	gate: Gate,
	farm: Farm,
	lumberCamp: LumberCamp,
	foodDepot: FoodDepot,
	miningCamp: MiningCamp,
} as const satisfies Record<BuildingType, BuildingConstructor>;

export function createBuilding(type: BuildingType, init: BuildingInit): BuildingEntity {
	const BuildingClass = BUILDING_TYPES[type];
	return new BuildingClass(init);
}

export function deserializeBuilding(snapshot: BuildingSnapshot): BuildingEntity {
	const completed = snapshot.completed ?? snapshot.hp >= snapshot.maxHp;
	const building = createBuilding(snapshot.type, { ...snapshot, completed });
	building.x = snapshot.x;
	building.y = snapshot.y;
	building.hp = snapshot.hp;
	building.completed = completed;
	building.repairPaidUntilHp = snapshot.repairPaidUntilHp;
	building.builderIds = snapshot.builderIds;
	if (snapshot.queue !== undefined) building.queue = snapshot.queue;
	if (snapshot.rallyPoint !== undefined) building.rallyPoint = snapshot.rallyPoint;
	if (snapshot.cooldown !== undefined) building.cooldown = snapshot.cooldown;
	if (snapshot.attackFlash !== undefined) building.attackFlash = snapshot.attackFlash;
	if (snapshot.amount !== undefined) building.amount = snapshot.amount;
	if (snapshot.maxAmount !== undefined) building.maxAmount = snapshot.maxAmount;
	if (snapshot.resource !== undefined) building.resource = snapshot.resource;
	if (snapshot.exhausted !== undefined) building.exhausted = snapshot.exhausted;
	return building;
}
