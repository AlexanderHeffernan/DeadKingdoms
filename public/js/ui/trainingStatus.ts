import { unitBehaviorFor } from "../../../src/shared/unitRegistry.js";
import type { Building } from "../../../src/shared/types.js";
import type { ClientSnapshot, GameState } from "../clientTypes.js";
import type { GameUiComponent } from "./component.js";
import type { HoverCard } from "./hoverCard.js";
import { icon } from "./icons.js";

export class TrainingStatusPanel implements GameUiComponent {
	private readonly state: GameState;
	private readonly el: HTMLElement;
	private readonly hoverCard: HoverCard;
	private signature = "";

	constructor(state: GameState, el: HTMLElement, hoverCard: HoverCard) {
		this.state = state;
		this.el = el;
		this.hoverCard = hoverCard;
	}

	render(snapshot: ClientSnapshot) {
		const playerId = this.state.playerId;
		if (!playerId) {
			this.hide();
			return;
		}
		const buildings = Object.values(snapshot.buildings)
			.filter((building) => building.ownerId === playerId && building.queue?.[0])
			.sort((left, right) => left.id.localeCompare(right.id));
		const signature = JSON.stringify(buildings.map((building) => {
			const item = building.queue![0]!;
			return [building.id, item.unitType, Math.ceil(item.remaining * 10)];
		}));
		if (signature === this.signature) return;
		this.signature = signature;
		this.el.classList.toggle("hidden", buildings.length === 0);
		this.el.innerHTML = "";
		for (const building of buildings) this.el.append(this.renderItem(building));
	}

	private renderItem(building: Building) {
		const item = building.queue![0]!;
		const unit = unitBehaviorFor(item.unitType);
		const progress = progressFor(item.remaining, unit.trainTime);
		const entry = document.createElement("button");
		entry.className = "training-status-item";
		entry.type = "button";
		entry.setAttribute("aria-label", `${unit.label} training ${Math.round(progress * 100)}%`);
		entry.dataset.hoverTitle = `${unit.label} ${formatTrainingTime(item.remaining)}`;
		entry.dataset.hoverDetail = `click to select building`;
		entry.append(icon(item.unitType));

		const bar = document.createElement("span");
		bar.className = "training-status-progress";
		const fill = document.createElement("span");
		fill.className = "training-status-progress-fill";
		fill.style.width = `${Math.round(progress * 100)}%`;
		bar.append(fill);
		entry.append(bar);
		entry.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.selectBuilding(building.id);
		});
		entry.addEventListener("mouseenter", () => this.hoverCard.showInfo(entry));
		entry.addEventListener("mousemove", () => this.hoverCard.showInfo(entry));
		entry.addEventListener("mouseleave", () => this.hoverCard.hide());
		return entry;
	}

	private selectBuilding(buildingId: string) {
		this.state.selectedIds.clear();
		this.state.selectedIds.add(buildingId);
		this.hoverCard.hide();
	}

	private hide() {
		this.signature = "";
		this.el.classList.add("hidden");
		this.el.innerHTML = "";
		this.hoverCard.hide();
	}
}

function progressFor(remaining: number, trainTime: number) {
	if (trainTime <= 0) return 1;
	return Math.max(0, Math.min(1, 1 - Math.max(0, remaining) / trainTime));
}

function formatTrainingTime(seconds: number) {
	const remaining = Math.max(0, Math.ceil(seconds));
	const minutes = Math.floor(remaining / 60);
	const partial = remaining % 60;
	if (minutes <= 0) return `${partial}s`;
	return `${minutes}:${partial.toString().padStart(2, "0")}`;
}
