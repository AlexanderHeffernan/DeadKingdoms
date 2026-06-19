import type { UnitType } from "../../types.js";
import type { UnitClass } from "../../units/index.js";
import { DepotBuilding } from "./DepotBuilding.js";
import type { BuildingSnapshot } from "./types.js";

export abstract class ProductionDepotBuilding extends DepotBuilding {
	queue = [];
	rallyPoint = null;

	canTrain(unitType: UnitType) {
		return this.trainableUnitClasses().some((Unit) => Unit.type === unitType);
	}

	trainableUnits() {
		return this.trainableUnitClasses().map((Unit) => Unit.type);
	}

	trainableUnitClasses() {
		return (this.constructor as unknown as { trains: readonly UnitClass[] }).trains;
	}

	protected serializeExtra(): Partial<BuildingSnapshot> {
		return {
			...super.serializeExtra(),
			queue: this.queue,
			rallyPoint: this.rallyPoint,
		};
	}
}
