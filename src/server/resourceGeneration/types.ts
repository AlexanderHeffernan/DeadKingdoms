import type { ResourceNodeType, ResourceType, Vec2 } from "../../shared/types.js";

export interface PlannedResource extends Vec2 {
	type: ResourceNodeType;
}

export interface ResourceTypePlacementReport {
	resource: ResourceType;
	density: number;
	eligible: number;
	target: number;
	achieved: number;
	clusters: number;
	candidateEvaluations: number;
	saturated: boolean;
}

export interface ResourceGenerationReport {
	seed: string;
	mapSize: number;
	durationMs: number;
	resources: Record<ResourceType, ResourceTypePlacementReport>;
}
