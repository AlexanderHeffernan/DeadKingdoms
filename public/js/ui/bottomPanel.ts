import { BUILDINGS, TRAINING } from "../constants.js";
import { palette } from "../sprites/palette.js";
import { sprites } from "../sprites/index.js";
import { unitBehaviorFor } from "../../../src/shared/unitRegistry.js";
import type { Building, ResourceNode, SpriteName, Unit } from "../../../src/shared/types.js";
import type { ClientSnapshot, GameState, SelectionEntity, UIActions } from "../clientTypes.js";
import type { GameUiComponent } from "./component.js";
import { escapeHtml, label } from "./dom.js";
import type { HoverCard } from "./hoverCard.js";

const BUILD_SHORTCUTS = {
	house: "H",
	farm: "F",
	barracks: "B",
	watchTower: "T",
	lumberCamp: "L",
	foodDepot: "D",
	miningCamp: "M",
};

export class BottomPanel implements GameUiComponent {
	private readonly state: GameState;
	private readonly actions: UIActions;
	private readonly selection: HTMLElement;
	private readonly actionsEl: HTMLElement;
	private readonly hoverCard: HoverCard;
	private actionSignature = "";

	constructor(state: GameState, actions: UIActions, selection: HTMLElement, actionsEl: HTMLElement, hoverCard: HoverCard) {
		this.state = state;
		this.actions = actions;
		this.selection = selection;
		this.actionsEl = actionsEl;
		this.hoverCard = hoverCard;
	}

	render(snapshot: ClientSnapshot) {
		const selected = [...this.state.selectedIds]
		.map((id) => snapshot.units[id] || snapshot.buildings[id] || snapshot.resources[id])
		.filter((item): item is SelectionEntity => Boolean(item));
		if (selected.length === 0) {
			const defeated = this.state.playerId ? snapshot.players[this.state.playerId]?.defeated : undefined;
			this.selection.innerHTML = `<div class="selection-title">${defeated ? "Defeated" : "No selection"}</div><div class="selection-detail">${defeated ? "Refresh and join again to start from scratch." : "Drag-select units. Right-click to move, gather, or attack."}</div>`;
			this.renderActionSet(defeated ? [{ spriteName: "townCenter", label: "Respawn", cost: {}, action: () => this.actions.respawn() }] : []);
			return;
		}
		const first = selected[0]!;
		const owner = first.ownerId ? snapshot.players[first.ownerId] : null;
		const ownership = owner ? (owner.id === this.state.playerId! ? "Owned by you" : `Owned by ${escapeHtml(owner.name)}`) : "Neutral";
		const names = selected.reduce<Record<string, number>>((counts, entity) => {
			counts[entity.type] = (counts[entity.type] || 0) + 1;
			return counts;
		}, {});
		const carried = isUnit(first) && first.carried ? ` · carrying ${Math.floor(first.carried.amount)} ${first.carried.resource}` : "";
		const resource = first.kind === "resource" ? ` · ${Math.floor(first.amount)}/${first.maxAmount} ${first.resource} left` : "";
		const farm = isBuilding(first) && first.gatherResource()
			? ` · ${Math.floor(first.amount || 0)}/${first.maxAmount || 0} food left${first.exhausted ? " · exhausted" : ""}`
			: "";
		this.selection.innerHTML = `
<div class="selection-title">${Object.entries(names).map(([type, count]) => `${label(type)} x${count}`).join(", ")}</div>
<div class="selection-detail">${ownership}${"hp" in first ? ` · ${Math.round(first.hp)}/${first.maxHp} hp` : ""}${carried}${resource}${farm}</div>
`;
		this.renderActions(selected);
	}

	private renderActions(selected: SelectionEntity[]) {
		const actions = [];
		const ownedUnits = selected.filter((entity): entity is Unit => entity.kind === "unit" && entity.ownerId === this.state.playerId);
		const ownedAnyBuildings = selected.filter((entity): entity is Building => entity.kind === "building" && entity.ownerId === this.state.playerId);
		const ownedBuildings = selected.filter((entity): entity is Building => entity.kind === "building" && entity.ownerId === this.state.playerId && isComplete(entity));
		const hasBuilder = ownedUnits.some((entity) => unitBehaviorFor(entity.type).canBuild());
		if (hasBuilder) {
			for (const [buildingType, def] of Object.entries(BUILDINGS)) {
				actions.push({ spriteName: buildingType, label: def.label, cost: def.cost, shortcut: BUILD_SHORTCUTS[buildingType as keyof typeof BUILD_SHORTCUTS], action: () => this.actions.setBuildMode(buildingType) });
			}
		}
		for (const building of ownedBuildings) {
			if (building.gatherResource()) {
				const player = this.state.snapshot!.players[this.state.playerId!];
				if (!player) continue;
				actions.push({ spriteName: building.type, label: player.autoReplenishFarms ? "Auto reseed: on" : "Auto reseed: off", cost: {}, displayCost: { wood: 45 }, shortcut: "A", action: () => this.actions.toggleAutoFarm() });
				actions.push({ spriteName: building.type, label: "Reseed farm", cost: { wood: 45 }, shortcut: "R", action: () => this.actions.replenishFarm(building.id), forceDisabled: !building.exhausted && (building.amount ?? 0) > 0 });
			}
			if (building.queue?.length) {
				const first = building.queue[0];
				if (first) actions.push({ queue: true, label: `Training ${building.queue.length}/10`, detail: `${Math.max(0, Math.round(first.remaining))}s` });
			}
			const training = TRAINING[building.type as keyof typeof TRAINING];
			if (training) {
				for (const train of training) {
					actions.push({ spriteName: train.unitType, label: train.label, cost: train.cost, shortcut: train.shortcut, action: () => this.actions.train(building.id, train.unitType), forceDisabled: (building.queue?.length ?? 0) >= 10 });
				}
			}
			if (training?.length) {
				actions.push({ spriteName: training[0]?.unitType, label: "Set rally point", cost: {}, shortcut: "Y", action: () => this.actions.setRallyMode(building.id) });
			}
		}
		for (const building of ownedAnyBuildings) {
			actions.push({ spriteName: "ruin", label: `Delete ${label(building.type)}`, cost: {}, shortcut: "Del", action: () => this.actions.deleteBuilding(building.id) });
		}
		this.renderActionSet(actions);
	}

	private renderActionSet(actions: ActionDef[]) {
		const player = this.state.snapshot?.players[this.state.playerId || ""];
		if (!player) return;
		const signature = JSON.stringify(actions.map((action) => ({
			queue: action.queue,
			spriteName: action.spriteName,
			label: action.label,
			detail: action.detail,
			cost: action.displayCost || action.cost,
			shortcut: action.shortcut,
			disabled: action.forceDisabled || !canAfford(player.resources, action.cost || {}),
		})));
		if (signature === this.actionSignature) return;
		this.actionSignature = signature;
		this.actionsEl.innerHTML = "";
		this.hoverCard.hide();
		for (const action of actions) {
			if (action.queue) this.addQueue(action.label, action.detail ?? "");
				else this.addButton(action.spriteName ?? "", action.label, action.cost ?? {}, action.action ?? (() => {}), action.forceDisabled, action.displayCost, action.shortcut ?? "");
		}
	}

	private addQueue(label: string, detail: string) {
		const queue = document.createElement("div");
		queue.className = "queue";
		queue.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span>`;
		this.actionsEl.append(queue);
	}

	private addButton(spriteName: string, label: string, cost: Record<string, number> = {}, onPointerDown: () => void, forceDisabled = false, displayCost: Record<string, number> | null = null, shortcut = "") {
		const player = this.state.snapshot?.players[this.state.playerId || ""];
		if (!player) return;
		const disabled = forceDisabled || !canAfford(player.resources, cost);
		const button = document.createElement("button");
		button.className = "action";
		button.disabled = disabled;
		button.type = "button";
		button.setAttribute("aria-label", label);
		button.dataset.label = label;
		button.dataset.cost = formatCost(displayCost || cost);
		button.dataset.shortcut = shortcut || "";
		button.dataset.disabledReason = disabled ? disabledReason(player.resources, cost, forceDisabled) : "";
		button.append(icon(spriteName));
		button.addEventListener("pointerdown", (event: PointerEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (!button.disabled) onPointerDown();
		});
		button.addEventListener("mouseenter", () => this.hoverCard.showAction(button));
		button.addEventListener("mousemove", () => this.hoverCard.showAction(button));
		button.addEventListener("mouseleave", () => this.hoverCard.hide());
		this.actionsEl.append(button);
	}
}

function isUnit(entity: SelectionEntity): entity is Unit {
	return entity.kind === "unit";
}

function isBuilding(entity: SelectionEntity): entity is Building {
	return entity.kind === "building";
}

function canAfford(resources: Record<string, number>, cost: Record<string, number>) {
	return Object.entries(cost).every(([resource, amount]) => (resources[resource] || 0) >= amount);
}

function isComplete(entity: Building) {
	return !entity.maxHp || entity.hp >= entity.maxHp;
}

function formatCost(cost: Record<string, number>) {
	const text = Object.entries(cost).map(([resource, amount]) => `${amount} ${resource}`).join(", ");
	return text || "free";
}

function disabledReason(resources: Record<string, number>, cost: Record<string, number>, forceDisabled: boolean) {
	if (forceDisabled) return "Unavailable right now";
	const missing = Object.entries(cost).filter(([resource, amount]) => (resources[resource] || 0) < amount);
	if (!missing.length) return "";
	return `Need ${missing.map(([resource, amount]) => `${amount - Math.floor(resources[resource] || 0)} more ${resource}`).join(", ")}`;
}

function icon(spriteName: string) {
	const canvas = document.createElement("canvas");
	canvas.className = "action-icon";
	canvas.width = 56;
	canvas.height = 56;
	const ctx = canvas.getContext("2d")!;
	ctx.imageSmoothingEnabled = false;
	const rows = sprites[spriteName as SpriteName] || sprites.house;
	const scale = Math.max(1, Math.floor(52 / Math.max(rows.length, rows[0]!.length)));
	const ox = Math.floor((56 - rows[0]!.length * scale) / 2);
	const oy = Math.floor((56 - rows.length * scale) / 2);
	for (let y = 0; y < rows.length; y += 1) {
		for (let x = 0; x < rows[y]!.length; x += 1) {
			const key = rows[y]![x];
			const color = key === "p" ? "#4f8fd8" : key === "P" ? "#7eb2ee" : palette[key as keyof typeof palette];
			if (!color) continue;
			ctx.fillStyle = color;
			ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
		}
	}
	return canvas;
}

type ActionDef = {
	queue?: boolean;
	spriteName?: string;
	label: string;
	detail?: string;
	cost?: Record<string, number>;
	displayCost?: Record<string, number>;
	shortcut?: string;
	action?: () => void;
	forceDisabled?: boolean;
};
