import { Building } from "./Building.js";
import type { BuildingSnapshot } from "./types.js";

export abstract class AttackingBuilding extends Building {
	cooldown = 0;
	attackFlash = 0;

	get canAttack() { return true; }
	get attack() { return (this.constructor as unknown as { attack: number }).attack; }
	get attackRange() { return (this.constructor as unknown as { attackRange: number }).attackRange; }
	get attackCooldown() { return (this.constructor as unknown as { attackCooldown: number }).attackCooldown; }

	protected serializeExtra(): Partial<BuildingSnapshot> {
		return {
			...super.serializeExtra(),
			cooldown: this.cooldown,
			attackFlash: this.attackFlash,
		};
	}
}
