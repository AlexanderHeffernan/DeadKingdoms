import { RESOURCE_DEFS } from "../../shared/config.js";
import { Logs } from "../../shared/logs.js";
import type { ResourceType, World } from "../../shared/types.js";
import { id } from "../id.js";
import { ConnectedResourcePolicy } from "./ConnectedResourcePolicy.js";
import { ResourceCandidatePool } from "./ResourceCandidatePool.js";
import type { ResourceDistributionPolicy } from "./ResourceDistributionPolicy.js";
import { ResourcePlacementGrid } from "./ResourcePlacementGrid.js";
import { ResourcePlacementReport } from "./ResourcePlacementReport.js";
import { SeededRng } from "./SeededRng.js";
import { TreeDistributionPolicy } from "./TreeDistributionPolicy.js";
import type { PlannedResource } from "./types.js";

const NORMAL_MAP_ELIGIBLE_TILES = 254 * 254;
const NORMAL_NODE_COUNTS: Record<ResourceType, number> = {
	wood: 12000,
	food: 345,
	ore: 555,
};

export class ResourceGenerator {
	private readonly grid: ResourcePlacementGrid;
	private readonly rng: SeededRng;
	private readonly planned: PlannedResource[] = [];

	public constructor(
		private readonly world: World,
		private readonly seed: string,
	) {
		this.grid = new ResourcePlacementGrid(world.map.size);
		this.rng = new SeededRng(seed).fork("resources");
	}

	public generate() {
		const startedAt = performance.now();
		const eligible = this.grid.eligibleIndices();
		const policies = this.createPolicies(eligible);

		while (policies.some((policy) => !policy.complete)) {
			const policy = policies
				.filter((candidate) => !candidate.complete)
				.sort((a, b) => a.completionRatio - b.completionRatio)[0];
			if (!policy) break;
			const resources = policy.placeNext();
			if (resources) this.planned.push(...resources);
		}

		this.commit();
		const report = new ResourcePlacementReport(
			this.seed,
			this.world.map.size,
			performance.now() - startedAt,
			policies.map((policy) => policy.report()),
		);
		if (report.saturated) Logs.log(`Resource generation ${report.summary()}.`);
		return report;
	}

	private createPolicies(eligible: number[]): ResourceDistributionPolicy[] {
		const settings = this.world.settings;
		if (!settings) throw new Error("ResourceGenerator requires resolved world settings.");
		const target = (resource: ResourceType) => Math.max(0, Math.round(
			eligible.length * (NORMAL_NODE_COUNTS[resource] / NORMAL_MAP_ELIGIBLE_TILES) * settings.resourceDensity[resource],
		));
		return [
			new TreeDistributionPolicy(
				target("wood"),
				settings.resourceDensity.wood,
				this.grid,
				new ResourceCandidatePool(this.world.map.size, eligible, this.rng.fork("wood:candidates")),
				new ResourceCandidatePool(this.world.map.size, eligible, this.rng.fork("wood:fallback-candidates")),
				this.rng.fork("wood:shapes"),
				1,
			),
			new ConnectedResourcePolicy(
				"ore",
				"ore",
				target("ore"),
				settings.resourceDensity.ore,
				this.grid,
				new ResourceCandidatePool(this.world.map.size, eligible, this.rng.fork("ore:candidates")),
				this.rng.fork("ore:shapes"),
				1_000_000,
				5,
				8,
			),
			new ConnectedResourcePolicy(
				"food",
				"berry",
				target("food"),
				settings.resourceDensity.food,
				this.grid,
				new ResourceCandidatePool(this.world.map.size, eligible, this.rng.fork("food:candidates")),
				this.rng.fork("food:shapes"),
				2_000_000,
				4,
				7,
			),
		];
	}

	private commit() {
		for (const placement of this.planned) {
			const definition = RESOURCE_DEFS[placement.type];
			const resourceId = id("r");
			this.world.resources[resourceId] = {
				id: resourceId,
				kind: "resource",
				type: placement.type,
				x: placement.x,
				y: placement.y,
				amount: definition.amount,
				maxAmount: definition.amount,
				resource: definition.resource,
				stage: placement.type,
				decay: 0,
			};
		}
	}
}
