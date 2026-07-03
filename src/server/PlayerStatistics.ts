import { RESOURCE_TYPES } from "../shared/config.js";
import type { PlayerStatisticsSnapshot, PlayerStatisticsTracker, ResourceType } from "../shared/types.js";
import type { UnitBehavior } from "../shared/units/index.js";

export class PlayerStatistics implements PlayerStatisticsTracker {
	private static readonly scoreSampleIntervalMs = 5000;
	private static readonly maxScoreSamples = 720;
	private readonly startedAt = Date.now();
	private readonly resourcesCollected = Object.fromEntries(RESOURCE_TYPES.map((resource) => [resource, 0])) as Record<ResourceType, number>;
	private unitsKilled = 0;
	private unitsLost = 0;
	private buildingsRazed = 0;
	private buildingsLost = 0;
	private militaryUnits = 0;
	private largestArmy = 0;
	private villagers = 0;
	private villagerHigh = 0;
	private totalVillagerSeconds = 0;
	private unidleVillagerSeconds = 0;
	private finishedAt: number | null = null;
	private readonly scoreHistory: PlayerStatisticsSnapshot["scoreHistory"] = [];
	private latestScore = 0;
	private lastScoreSampleAt = 0;

	recordUnitCreated(unit: UnitBehavior) {
		if (unit.countsAsVillager()) {
			this.villagers += 1;
			this.villagerHigh = Math.max(this.villagerHigh, this.villagers);
		}
		if (unit.countsAsMilitary()) {
			this.militaryUnits += 1;
			this.largestArmy = Math.max(this.largestArmy, this.militaryUnits);
		}
	}

	recordUnitRemoved(unit: UnitBehavior, combatLoss: boolean) {
		if (unit.countsAsVillager()) this.villagers = Math.max(0, this.villagers - 1);
		if (unit.countsAsMilitary()) this.militaryUnits = Math.max(0, this.militaryUnits - 1);
		if (combatLoss) this.unitsLost += 1;
	}

	recordUnitKilled() { this.unitsKilled += 1; }
	recordBuildingLost() { this.buildingsLost += 1; }
	recordBuildingRazed() { this.buildingsRazed += 1; }

	recordResourcesCollected(resource: ResourceType, amount: number) {
		this.resourcesCollected[resource] += amount;
	}

	recordScore(score: number) {
		if (this.finishedAt !== null) return;
		this.latestScore = score;
		const now = Date.now();
		if (now - this.lastScoreSampleAt >= PlayerStatistics.scoreSampleIntervalMs) this.addScoreSample(now);
	}

	advance(dt: number, idleVillagers: number) {
		if (this.finishedAt !== null || this.villagers === 0) return;
		this.totalVillagerSeconds += this.villagers * dt;
		this.unidleVillagerSeconds += Math.max(0, this.villagers - idleVillagers) * dt;
	}

	finish() {
		if (this.finishedAt !== null) return;
		this.finishedAt = Date.now();
		this.addScoreSample(this.finishedAt);
	}

	snapshot(): PlayerStatisticsSnapshot {
		return {
			scoreHistory: this.scoreHistory.map((sample) => ({ ...sample })),
			military: {
				unitsKilled: this.unitsKilled,
				unitsLost: this.unitsLost,
				buildingsRazed: this.buildingsRazed,
				buildingsLost: this.buildingsLost,
				largestArmy: this.largestArmy,
			},
			economy: {
				resourcesCollected: { ...this.resourcesCollected },
				villagerHigh: this.villagerHigh,
				villagerUtilisation: this.totalVillagerSeconds > 0 ? this.unidleVillagerSeconds / this.totalVillagerSeconds : 0,
			},
			durationSeconds: Math.max(0, ((this.finishedAt ?? Date.now()) - this.startedAt) / 1000),
		};
	}

	private addScoreSample(at: number) {
		const last = this.scoreHistory.at(-1);
		const previous = this.scoreHistory.at(-2);
		const atSeconds = Math.max(0, (at - this.startedAt) / 1000);
		if (last && previous && last.score === this.latestScore && previous.score === this.latestScore) last.atSeconds = atSeconds;
		else this.scoreHistory.push({ atSeconds, score: this.latestScore });
		this.lastScoreSampleAt = at;
		if (this.scoreHistory.length > PlayerStatistics.maxScoreSamples) this.scoreHistory.shift();
	}
}
