import type { ResourceType } from "../../shared/types.js";
import type { ResourceGenerationReport, ResourceTypePlacementReport } from "./types.js";

export class ResourcePlacementReport implements ResourceGenerationReport {
	public readonly resources: Record<ResourceType, ResourceTypePlacementReport>;

	public constructor(
		public readonly seed: string,
		public readonly mapSize: number,
		public readonly durationMs: number,
		reports: ResourceTypePlacementReport[],
	) {
		this.resources = Object.fromEntries(reports.map((report) => [report.resource, report])) as Record<ResourceType, ResourceTypePlacementReport>;
	}

	public get saturated() {
		return Object.values(this.resources).some((report) => report.saturated);
	}

	public summary() {
		return Object.values(this.resources)
			.map((report) => `${report.resource} ${report.achieved}/${report.target}${report.saturated ? " (saturated)" : ""}`)
			.join(", ");
	}
}
