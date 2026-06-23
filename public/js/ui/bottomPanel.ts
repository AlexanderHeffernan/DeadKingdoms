import { BUILDINGS, TRAINING } from "../constants.js";
import { palette } from "../sprites/palette.js";
import { sprites } from "../sprites/index.js";
import { pngSprites } from "../sprites/pngSprites.js";
import { unitBehaviorFor } from "../../../src/shared/unitRegistry.js";
import type { Building, ResourceNode, ResourceType, SpriteName, Unit } from "../../../src/shared/types.js";
import type { ClientSnapshot, GameState, SelectionEntity, UIActions } from "../clientTypes.js";
import type { GameUiComponent } from "./component.js";
import { escapeHtml, label } from "./dom.js";
import type { HoverCard } from "./hoverCard.js";
import { resourceIcon } from "./resources.js";

const BUILD_SHORTCUTS = {
	house: "H",
	farm: "F",
	barracks: "B",
	watchTower: "T",
	wall: "W",
	gate: "G",
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
			this.selection.classList.remove("multi-selection");
			this.selection.innerHTML = `<div class="selection-title">${defeated ? "Defeated" : "No selection"}</div><div class="selection-detail">${defeated ? "Refresh and join again to start from scratch." : "Drag-select units. Right-click to move, gather, or attack."}</div>`;
			this.renderActionSet(defeated ? [new ButtonAction({ spriteName: "townCenter", label: "Respawn", cost: {}, run: () => this.actions.respawn() })] : []);
			return;
		}
		const selectedUnits = selected.filter(isUnit);
		if (selectedUnits.length > 1) {
			this.renderActions(selected);
			this.renderMultiUnitSelection(selectedUnits, snapshot);
			return;
		}
		this.selection.classList.remove("multi-selection");
		const first = selected[0]!;
		const owner = first.ownerId ? snapshot.players[first.ownerId] : null;
		const ownership = owner ? (owner.id === this.state.playerId! ? "Owned by you" : `Owned by ${escapeHtml(owner.name)}`) : "Neutral";
		const names = selected.reduce<Record<string, number>>((counts, entity) => {
			const name = selectionName(entity);
			counts[name] = (counts[name] || 0) + 1;
			return counts;
		}, {});
		const carried = isUnit(first) ? carriedDetail(first) : "";
		const resource = first.kind === "resource" ? ` · ${Math.floor(first.amount)}/${first.maxAmount} ${first.resource} left` : "";
		const farm = isBuilding(first) && first.gatherResource
			? ` · ${Math.floor(first.amount || 0)}/${first.maxAmount || 0} food left${first.exhausted ? " · exhausted" : ""}`
			: "";
		this.selection.innerHTML = `
<div class="selection-title">${Object.entries(names).map(([name, count]) => `${escapeHtml(name)} x${count}`).join(", ")}</div>
<div class="selection-detail">${ownership}${"hp" in first ? ` · ${Math.round(first.hp)}/${first.maxHp} hp` : ""}${carried}${resource}${farm}</div>
`;
		this.renderActions(selected);
	}

	private renderMultiUnitSelection(units: Unit[], snapshot: ClientSnapshot) {
		this.selection.classList.add("multi-selection");
		this.selection.innerHTML = "";
		for (const [unitType, matchingUnits] of Object.entries(unitsByType(units))) {
			const count = matchingUnits.length;
			const item = document.createElement("div");
			item.className = "multi-selection-icon";
			item.setAttribute("aria-label", `${label(unitType)} x${count}`);
			const ownerColor = matchingUnits[0]?.ownerId ? snapshot.players[matchingUnits[0]!.ownerId]?.color : undefined;
			item.append(icon(unitType, DEFAULT_HUD_ICON_OFFSET, DEFAULT_HUD_ICON_MAX_SIZE, ownerColor || DEFAULT_HUD_ICON_COLOR));
			item.append(multiSelectionHealthBar(matchingUnits));
			item.append(multiSelectionHealthList(matchingUnits));
			item.addEventListener("pointerdown", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (event.metaKey) this.removeUnitTypeFromSelection(matchingUnits, snapshot);
					else this.selectOnlyUnitType(matchingUnits, snapshot);
			});
			if (count > 1) {
				const badge = document.createElement("span");
				badge.className = "multi-selection-count";
				badge.textContent = String(count);
				item.append(badge);
			}
			this.selection.append(item);
		}
	}

	private selectOnlyUnitType(units: Unit[], snapshot: ClientSnapshot) {
		this.state.selectedIds.clear();
		for (const unit of units) this.state.selectedIds.add(unit.id);
		this.render(snapshot);
	}

	private removeUnitTypeFromSelection(units: Unit[], snapshot: ClientSnapshot) {
		for (const unit of units) this.state.selectedIds.delete(unit.id);
		this.render(snapshot);
	}

	private renderActions(selected: SelectionEntity[]) {
		const actions = [];
		const ownedUnits = selected.filter((entity): entity is Unit => entity.kind === "unit" && entity.ownerId === this.state.playerId);
		const ownedAnyBuildings = selected.filter((entity): entity is Building => entity.kind === "building" && entity.ownerId === this.state.playerId);
		const ownedBuildings = selected.filter((entity): entity is Building => entity.kind === "building" && entity.ownerId === this.state.playerId && isComplete(entity));
		const hasBuilder = ownedUnits.some((entity) => unitBehaviorFor(entity.type).canBuild);
		const scouts = ownedUnits.filter((entity) => entity.type === "scout");
		if (hasBuilder) {
			for (const [buildingType, def] of Object.entries(BUILDINGS)) {
				actions.push(new ButtonAction({
					spriteName: buildingType,
					label: def.label,
					description: def.description,
					cost: def.cost,
					shortcut: BUILD_SHORTCUTS[buildingType as keyof typeof BUILD_SHORTCUTS],
					run: () => this.actions.setBuildMode(buildingType),
				}));
			}
		}
		if (scouts.length > 0) {
			actions.push(new ButtonAction({
				spriteName: "scout",
				label: scouts.some((unit) => unit.hornActive) ? "Stop horn" : "Blow horn",
				cost: {},
				shortcut: "O",
				run: () => this.actions.blowHorn(scouts.map((unit) => unit.id)),
			}));
		}
		for (const building of ownedBuildings) {
			if (building.gatherResource) {
				const player = this.state.snapshot!.players[this.state.playerId!];
				if (!player) continue;
				actions.push(new ButtonAction({ spriteName: building.type, label: player.autoReplenishFarms ? "Auto reseed: on" : "Auto reseed: off", cost: {}, displayCost: { wood: 45 }, shortcut: "A", run: () => this.actions.toggleAutoFarm() }));
				actions.push(new ButtonAction({ spriteName: building.type, label: "Reseed farm", cost: { wood: 45 }, shortcut: "R", run: () => this.actions.replenishFarm(building.id), forceDisabled: !building.exhausted && (building.amount ?? 0) > 0 }));
			}
			if (building.queue?.length) {
				const first = building.queue[0];
				if (first) actions.push(new QueueAction(`Training ${building.queue.length}/10`, `${Math.max(0, Math.round(first.remaining))}s`));
			}
			const training = TRAINING[building.type as keyof typeof TRAINING];
			if (training) {
				for (const train of training) {
					actions.push(new ButtonAction({ spriteName: train.unitType, label: train.label, cost: train.cost, shortcut: train.shortcut, run: () => this.actions.train(building.id, train.unitType), forceDisabled: (building.queue?.length ?? 0) >= 10 }));
				}
			}
			if (training?.length) {
				actions.push(new ButtonAction({ spriteName: training[0]?.unitType, label: "Set rally point", cost: {}, shortcut: "Y", run: () => this.actions.setRallyMode(building.id) }));
			}
		}
		for (const building of ownedAnyBuildings) {
			actions.push(new ButtonAction({ spriteName: "ruin", label: `Delete ${label(building.type)}`, cost: {}, shortcut: "Del", run: () => this.actions.deleteBuilding(building.id) }));
		}
		this.renderActionSet(actions);
	}

	private renderActionSet(actions: ActionDef[]) {
		const player = this.state.snapshot?.players[this.state.playerId || ""];
		if (!player) return;
		const signature = JSON.stringify(actions.map((action) => ({
			type: action.kind,
			spriteName: action.spriteName,
			iconSpriteName: action.getIconSpriteName(),
			iconColor: action.getIconColor(player.color),
			label: action.label,
			tooltip: action.getTooltip(),
			detail: action.detail,
			cost: action.displayCost || action.cost,
			disabled: action.forceDisabled || !canAfford(player.resources, action.cost || {}),
		})));
		if (signature === this.actionSignature) return;
		this.actionSignature = signature;
		this.actionsEl.innerHTML = "";
		this.actionsEl.classList.toggle("hidden", actions.length === 0);
		this.hoverCard.hide();
		for (const action of actions) {
			if (action.kind === "queue") this.addQueue(action.label, action.detail ?? "");
				else this.addButton(action as ButtonAction, player);
		}
	}

	private addQueue(label: string, detail: string) {
		const queue = document.createElement("div");
		queue.className = "queue";
		queue.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span>`;
		this.actionsEl.append(queue);
	}

	private addButton(action: ButtonAction, player: ClientSnapshot["players"][string]) {
		const tooltip = action.getTooltip();
		const disabled = action.forceDisabled || !canAfford(player.resources, action.cost);
		const button = document.createElement("button");
		button.className = "action";
		button.disabled = disabled;
		button.type = "button";
		button.setAttribute("aria-label", action.label);
		button.dataset.label = tooltip.label;
		button.dataset.description = tooltip.description ?? "";
		button.dataset.cost = tooltip.cost;
		button.dataset.shortcut = tooltip.shortcut ?? "";
		button.dataset.disabledReason = disabled ? disabledReason(player.resources, action.cost, action.forceDisabled) : "";
		button.append(icon(action.getIconSpriteName(), action.getIconOffset(), action.getIconMaxSize(), action.getIconColor(player.color)));
		button.addEventListener("pointerdown", (event: PointerEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (!button.disabled) action.run();
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

function unitsByType(units: Unit[]) {
	return units.reduce<Record<string, Unit[]>>((groups, unit) => {
		groups[unit.type] ??= [];
		groups[unit.type]!.push(unit);
		return groups;
	}, {});
}

function multiSelectionHealthBar(units: Unit[]) {
	const bar = document.createElement("span");
	bar.className = "multi-selection-health";
	const average = units.length
		? units.reduce((sum, unit) => sum + Math.max(0, unit.hp) / Math.max(1, unit.maxHp), 0) / units.length
		: 0;
	const fill = document.createElement("span");
	fill.className = "multi-selection-health-fill";
	fill.style.width = `${Math.round(average * 100)}%`;
	bar.append(fill);
	return bar;
}

function multiSelectionHealthList(units: Unit[]) {
	const list = document.createElement("span");
	list.className = "multi-selection-health-list";
	for (const unit of units) {
		const row = document.createElement("span");
		row.textContent = `${Math.round(unit.hp)}/${unit.maxHp}`;
		list.append(row);
	}
	return list;
}

function selectionName(entity: SelectionEntity) {
	if (!isUnit(entity)) return label(entity.type);
	if (entity.type !== "villager") return unitBehaviorFor(entity.type).label;
	if (entity.command.type === "gather") return villagerGatherJob(entity.command.resourceKind);
	if (entity.command.type === "build") return "Builder";
	if (entity.command.type === "attack") return "Villager";
	return unitBehaviorFor(entity.type).label;
}

function villagerGatherJob(resource: ResourceType) {
	if (resource === "wood") return "Lumberjack";
	if (resource === "food") return "Farmer";
	if (resource === "ore") return "Quarryman";
	return "Villager";
}

function carriedDetail(unit: Unit) {
	const capacity = unitBehaviorFor(unit.type).carryCapacity;
	if (capacity <= 0) return "";
	const carried = unit.carried;
	const resource = carried?.resource ?? gatherResourceForCommand(unit);
	if (!resource) return "";
	const amount = Math.floor(carried?.amount ?? 0);
	return `<span class="selection-carry">${resourceIcon(resource)} <span>${amount}/${capacity}</span></span>`;
}

function gatherResourceForCommand(unit: Unit) {
	return unit.command.type === "gather" ? unit.command.resourceKind : null;
}

function canAfford(resources: Record<string, number>, cost: Record<string, number>) {
	return Object.entries(cost).every(([resource, amount]) => (resources[resource] || 0) >= amount);
}

function isComplete(entity: Building) {
	return entity.completed;
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

type HudIconOffset = {
	x: number;
	y: number;
};

const DEFAULT_HUD_ICON_OFFSET: HudIconOffset = { x: 0, y: 0 };
const DEFAULT_HUD_ICON_MAX_SIZE = 28;
const DEFAULT_HUD_ICON_COLOR = "#4f8fd8";

function icon(
	spriteName: string,
	offset: HudIconOffset = DEFAULT_HUD_ICON_OFFSET,
	maxSize = DEFAULT_HUD_ICON_MAX_SIZE,
	flagColor: string = DEFAULT_HUD_ICON_COLOR,
) {
	const png = pngSprites[spriteName as SpriteName];
	if (png) return pngIcon(png, offset, maxSize, flagColor);
	const canvas = document.createElement("canvas");
	canvas.className = "action-icon";
	canvas.width = 56;
	canvas.height = 56;
	const ctx = canvas.getContext("2d")!;
	ctx.imageSmoothingEnabled = false;
	const rows = sprites[spriteName as SpriteName] || sprites.house!;
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

function pngIcon(png: NonNullable<(typeof pngSprites)[SpriteName]>, offset: HudIconOffset, maxSize: number, flagColor: string) {
	const wrapper = document.createElement("span");
	const scale = Math.min(2, maxSize / png.width, maxSize / png.height);
	wrapper.className = "action-icon action-icon-png";
	wrapper.style.setProperty("--icon-width", `${png.width * scale}px`);
	wrapper.style.setProperty("--icon-height", `${png.height * scale}px`);
	wrapper.style.setProperty("--icon-offset-x", `${offset.x}px`);
	wrapper.style.setProperty("--icon-offset-y", `${offset.y}px`);
	wrapper.style.setProperty("--icon-flag-color", flagColor);
	if (png.flag && png.flagLayer !== "over") wrapper.append(pngFlagLayer(png.flag));
	const base = document.createElement("img");
	base.src = png.base;
	base.alt = "";
	base.draggable = false;
	base.className = "action-icon-png-layer";
	wrapper.append(base);
	if (png.flag && png.flagLayer === "over") wrapper.append(pngFlagLayer(png.flag));
	return wrapper;
}

function pngFlagLayer(flagUrl: string) {
	const flag = document.createElement("span");
	flag.className = "action-icon-png-layer action-icon-png-flag";
	flag.style.setProperty("--flag-url", `url("${flagUrl}")`);
	return flag;
}

interface TooltipAction {
	readonly kind: "button" | "queue";
	readonly spriteName: string;
	readonly label: string;
	readonly detail?: string;
	readonly cost: Record<string, number>;
	readonly displayCost: Record<string, number> | null;
	readonly forceDisabled: boolean;
	getTooltip(): ActionTooltip;
	getIconSpriteName(): string;
	getIconMaxSize(): number;
	getIconColor(playerColor?: string): string;
}

type ActionTooltip = {
	label: string;
	description?: string;
	cost: string;
	shortcut?: string;
};

class ButtonAction implements TooltipAction {
	private static readonly iconSpriteNames: Partial<Record<SpriteName, SpriteName>> = {
		wall: "pillarConnected",
	};

	private static readonly iconOffsets: Partial<Record<SpriteName, HudIconOffset>> = {
		house: { x: -2, y: -2 },
		wall: { x: -2, y: -2 },
		gate: { x: 0, y: -2 },
	};

	private static readonly iconMaxSizes: Partial<Record<SpriteName, number>> = {
		wall: 31,
	};

	readonly kind = "button";
	readonly spriteName: string;
	readonly label: string;
	readonly description: string;
	readonly cost: Record<string, number>;
	readonly displayCost: Record<string, number> | null;
	readonly shortcut: string;
	readonly forceDisabled: boolean;
	private readonly onRun: () => void;

	constructor(def: ButtonActionDef) {
		this.spriteName = def.spriteName ?? "";
		this.label = def.label;
		this.description = def.description ?? "";
		this.cost = def.cost ?? {};
		this.displayCost = def.displayCost ?? null;
		this.shortcut = def.shortcut ?? "";
		this.forceDisabled = def.forceDisabled ?? false;
		this.onRun = def.run;
	}

	getTooltip(): ActionTooltip {
		return {
			label: this.label,
			...(this.description ? { description: this.description } : {}),
			cost: formatCost(this.displayCost || this.cost),
			...(this.shortcut ? { shortcut: this.shortcut } : {}),
		};
	}

	run() {
		this.onRun();
	}

	getIconSpriteName(): string {
		return ButtonAction.iconSpriteNames[this.spriteName as SpriteName] ?? this.spriteName;
	}

	getIconOffset(): HudIconOffset {
		return ButtonAction.iconOffsets[this.spriteName as SpriteName] ?? DEFAULT_HUD_ICON_OFFSET;
	}

	getIconMaxSize(): number {
		return ButtonAction.iconMaxSizes[this.spriteName as SpriteName] ?? DEFAULT_HUD_ICON_MAX_SIZE;
	}

	getIconColor(playerColor?: string): string {
		return playerColor || DEFAULT_HUD_ICON_COLOR;
	}
}

class QueueAction implements TooltipAction {
	readonly kind = "queue";
	readonly spriteName = "";
	readonly cost = {};
	readonly displayCost = null;
	readonly forceDisabled = false;

	constructor(
		readonly label: string,
		readonly detail: string,
	) {}

	getTooltip(): ActionTooltip {
		return {
			label: this.label,
			description: this.detail,
			cost: "free",
		};
	}

	getIconSpriteName(): string {
		return this.spriteName;
	}

	getIconMaxSize(): number {
		return DEFAULT_HUD_ICON_MAX_SIZE;
	}

	getIconColor(): string {
		return DEFAULT_HUD_ICON_COLOR;
	}
}

type ActionDef = TooltipAction;

type ButtonActionDef = {
	spriteName?: string;
	label: string;
	description?: string;
	cost?: Record<string, number>;
	displayCost?: Record<string, number>;
	shortcut?: string;
	run: () => void;
	forceDisabled?: boolean;
};
