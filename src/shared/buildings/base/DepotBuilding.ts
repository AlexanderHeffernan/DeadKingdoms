import type { ResourceType } from "../../types.js";
import { Building } from "./Building.js";

export abstract class DepotBuilding extends Building {
	canAcceptResource(resource: ResourceType) {
		return this.acceptedResources().includes(resource);
	}

	depotGatherKind(): ResourceType | null {
		const accepts = this.acceptedResources();
		return accepts.length === 1 ? accepts[0]! : null;
	}

	protected acceptedResources() {
		return (this.constructor as unknown as { accepts: readonly ResourceType[] }).accepts;
	}
}
