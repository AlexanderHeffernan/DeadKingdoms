import type { GameState } from "../clientTypes.js";
import type { UIActions } from "../clientTypes.js";
import type { ClientSnapshot } from "../clientTypes.js";
import type { GameUiComponent } from "./component.js";
import type { HoverCard } from "./hoverCard.js";

export class ResourcePanel implements GameUiComponent {
	private readonly state: GameState;
	private readonly el: HTMLElement;
	private readonly hoverCard: HoverCard;
	private readonly actions: UIActions;

	constructor(state: GameState, el: HTMLElement, hoverCard: HoverCard, actions: UIActions) {
		this.state = state;
		this.el = el;
		this.hoverCard = hoverCard;
		this.actions = actions;
	}

	render(snapshot: ClientSnapshot) {
		const playerId = this.state.playerId;
		if (!playerId) return;
		const player = snapshot.players[playerId];
		if (!player) return;
		const workerCounts = player.workerCounts;
		const idleWorkers = workerCounts.idle;
		this.el.innerHTML = `
			${resourcePill("wood", Math.floor(player.resources.wood), workerCounts.gathering.wood)}
			${resourcePill("food", Math.floor(player.resources.food), workerCounts.gathering.food)}
			${resourcePill("ore", Math.floor(player.resources.ore), workerCounts.gathering.ore)}
			<span
				class="population-resource-group resource-pill"
				data-hover-title="Population"
				data-hover-detail="${populationDescription(player.population, player.popCap, idleWorkers)}"
			>
				${populationPill(player.population, player.popCap, idleWorkers)}
			</span>
		`;
		this.attachHovers();
		this.attachPopulationButton();
	}

	private attachHovers() {
		for (const pill of Array.from(this.el.querySelectorAll<HTMLElement>(".resource-pill"))) {
			pill.addEventListener("mouseenter", () => this.hoverCard.showInfo(pill));
			pill.addEventListener("mousemove", () => this.hoverCard.showInfo(pill));
			pill.addEventListener("mouseleave", () => this.hoverCard.hide());
		}
	}

	private attachPopulationButton() {
		const button = this.el.querySelector<HTMLButtonElement>(".population-icon-button");
		if (!button) return;
		button.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.actions.selectIdleWorkers();
		});
	}
}

function resourcePill(resource: string, amount: number, gatherers: number) {
	return `<span class="resource-pill" data-hover-title="${resourceLabel(resource)}" data-hover-detail="${resourceDescription(resource)}">${resourceIcon(resource, gatherers)}<strong>${amount}</strong></span>`;
}

function populationPill(population: number, popCap: number, idleWorkers: number) {
	const active = idleWorkers > 0;
	return `<span class="population-pill">
		<button
			class="population-icon-button ${active ? "active" : ""}"
			type="button"
			aria-label="Select idle villager"
			aria-disabled="${String(!active)}"
		>${populationIcon(idleWorkers)}</button>
		<strong>${population}/${popCap}</strong>
	</span>`;
}

function populationDescription(population: number, popCap: number, idleWorkers: number) {
	const idleText = idleWorkers === 1 ? "1 worker is" : `${idleWorkers} workers are`;
	return `${population}/${popCap} used. ${idleText} not currently working. Click the population icon or press . to cycle idle workers one at a time.`;
}

function resourceLabel(resource: string) {
	return resource.replace(/^./, (char) => char.toUpperCase());
}

function resourceDescription(resource: string) {
	const descriptions = {
		wood: "Used to construct buildings, farms, and reseed exhausted farms.",
		food: "Used to train units. Gather from berries, farms, and food depots.",
		ore: "Used for military buildings, towers, and units.",
	};
	return descriptions[resource as keyof typeof descriptions] || "Stored resource.";
}

function populationIcon(idleWorkers: number) {
	return `<span class="resource-icon" aria-hidden="true">
<i style="left:9px;top:3px;background:#e0a46a"></i><i style="left:12px;top:3px;background:#e0a46a"></i>
<i style="left:9px;top:6px;background:#b2824f"></i><i style="left:12px;top:6px;background:#b2824f"></i>
<i style="left:6px;top:12px;background:#4f8fd8"></i><i style="left:9px;top:12px;background:#4f8fd8"></i><i style="left:12px;top:12px;background:#4f8fd8"></i><i style="left:15px;top:12px;background:#4f8fd8"></i>
<i style="left:6px;top:15px;background:#2f5d9a"></i><i style="left:9px;top:15px;background:#2f5d9a"></i><i style="left:12px;top:15px;background:#2f5d9a"></i><i style="left:15px;top:15px;background:#2f5d9a"></i>
<i style="left:9px;top:18px;background:#252321"></i><i style="left:15px;top:18px;background:#252321"></i>
${idleWorkerBadge(idleWorkers)}</span>`;
}

export function resourceIcon(resource: string, gatherers = 0) {
	const grids = {
		wood: [
			"........",
			".bbWWW..",
			"bBWWWWb.",
			".bbWWW..",
			"...bbWWW",
			"..bBWWWW",
			"...bbWWW",
			"........",
		],
		food: [
			"........",
			"...MM...",
			"..MFFM..",
			".MFRRFM.",
			".FRRRRF.",
			"..FRRF..",
			"...ff...",
			"........",
		],
		ore: [
			"........",
			"...QQ...",
			"..QMMQ..",
			".QMMMMQ.",
			"..QMMQ..",
			".QQ..QQ.",
			"QMMQQMMQ",
			"........",
		],
	};
	const colors = {
		".": "transparent",
		W: "#6a4a32",
		b: "#8b623e",
		B: "#b2824f",
		R: "#9f262f",
		F: "#d84b3e",
		f: "#f0a28a",
		Q: "#c1b77b",
		M: "#9aa3a0",
	};
	const grid = grids[resource as keyof typeof grids] || grids.wood;
	const pixels = grid.flatMap((row: string, y: number) =>
		[...row].map((key: string, x: number) => `<i style="left:${x * 3}px;top:${y * 3}px;background:${colors[key as keyof typeof colors]}"></i>`),
	).join("");
	return `<span class="resource-icon" aria-hidden="true">${pixels}${gathererBadge(gatherers)}</span>`;
}

function gathererBadge(gatherers: number) {
	return gatherers > 0 ? `<span class="resource-gatherer-badge">${gatherers}</span>` : "";
}

function idleWorkerBadge(idleWorkers: number) {
	return idleWorkers > 0 ? `<span class="population-idle-badge">${idleWorkers}</span>` : "";
}
