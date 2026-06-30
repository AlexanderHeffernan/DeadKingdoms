import { SCALE, TILE_H } from "./constants.js";
import type { GameState, ViewState } from "./clientTypes.js";
import { isoToScreen, screenToIso } from "./iso.js";
import { spriteMetrics } from "./sprites/spriteInfo.js";
import type { SoundEffects } from "./sfx.js";
import { unitBehaviorFor } from "../../src/shared/unitRegistry.js";
import type { Building, Corpse, ResourceNode, Ruin, Unit } from "../../src/shared/types.js";

type SelectableEntity = Unit | Building | ResourceNode | Corpse;
type StaticMemoryEntity = Building | ResourceNode | { x: number; y: number; size?: number; width?: number; height?: number };

export class SelectionController {
	constructor(
		private readonly state: GameState,
		private readonly view: ViewState,
		private readonly sfx: SoundEffects,
	) {}

	selectAt(x: number, y: number, additive = false) {
		const hit = this.hitTestForSelection(x, y);
		if (!additive) this.state.selectedIds.clear();
		if (additive && hit?.kind !== "unit") return;
		if (hit) this.state.selectedIds.add(hit.id);
		if (hit?.kind === "unit") this.sfx.play("ui_select_unit", { point: hit });
		else if (hit?.kind === "building") this.sfx.play("ui_select_building", { point: hit });
	}

	selectBox(additive = false) {
		if (!this.state.snapshot) return;
		if (!additive) this.state.selectedIds.clear();
		const left = Math.min(this.view.dragStart!.x, this.view.dragCurrent!.x);
		const right = Math.max(this.view.dragStart!.x, this.view.dragCurrent!.x);
		const top = Math.min(this.view.dragStart!.y, this.view.dragCurrent!.y);
		const bottom = Math.max(this.view.dragStart!.y, this.view.dragCurrent!.y);
		for (const unit of Object.values(this.state.snapshot.units)) {
			if (unit.ownerId !== this.state.playerId) continue;
			const p = isoToScreen(unit.x, unit.y, this.view.camera);
			if (p.x >= left && p.x <= right && p.y >= top - 40 && p.y <= bottom) this.state.selectedIds.add(unit.id);
		}
		if (this.state.selectedIds.size > 0) this.sfx.play("ui_select_unit", { volume: Math.min(1.7, 0.9 + this.state.selectedIds.size * 0.05) });
	}

	selectIdleWorkers() {
		const idle = Object.values(this.state.snapshot?.units || {})
			.filter((unit) => unit.ownerId === this.state.playerId && unitBehaviorFor(unit.type).canGather && (!unit.command || unit.command.type === "idle"))
			.sort((a, b) => a.id.localeCompare(b.id));
		this.state.selectedIds.clear();
		if (idle.length > 0) {
			this.state.idleWorkerCycleIndex = (this.state.idleWorkerCycleIndex + 1) % idle.length;
			this.state.selectedIds.add(idle[this.state.idleWorkerCycleIndex]!.id);
			this.sfx.play("ui_select_unit", { point: idle[0] });
		} else {
			this.state.idleWorkerCycleIndex = -1;
		}
	}

	hitTest(x: number, y: number): SelectableEntity | null {
		if (!this.state.snapshot) return null;
		const candidates = [
			...Object.values(this.state.snapshot.units),
			...Object.values(this.state.snapshot.buildings),
			...Object.values(this.state.snapshot.resources),
			...Object.values(this.state.snapshot.corpses),
		];
		return this.closestHit(x, y, candidates);
	}

	hitTestForSelection(x: number, y: number): SelectableEntity | null {
		if (!this.state.snapshot) return null;
		const unitHit = this.closestHit(x, y, Object.values(this.state.snapshot.units));
		if (unitHit) return unitHit;
		return this.hitTest(x, y);
	}

	rememberStaticObjects() {
		if (!this.state.snapshot) return;
		this.forgetVisibleMissing(this.state.lastSeen.buildings, this.state.snapshot.buildings);
		this.forgetVisibleMissing(this.state.lastSeen.resources, this.state.snapshot.resources);
		this.forgetVisibleMissing(this.state.lastSeen.ruins, this.state.snapshot.ruins);
		for (const [id, building] of Object.entries(this.state.snapshot.buildings)) this.state.lastSeen.buildings[id] = building;
		for (const [id, resource] of Object.entries(this.state.snapshot.resources)) this.state.lastSeen.resources[id] = resource;
		for (const [id, ruin] of Object.entries(this.state.snapshot.ruins)) this.state.lastSeen.ruins[id] = ruin;
	}

	cullSelection() {
		if (!this.state.snapshot) return;
		for (const id of [...this.state.selectedIds]) {
			if (!this.state.snapshot.units[id] && !this.state.snapshot.buildings[id] && !this.state.snapshot.resources[id] && !this.state.snapshot.corpses[id]) this.state.selectedIds.delete(id);
		}
	}

	entityWidth(entity: { size?: number; width?: number }) {
		return entity.width ?? entity.size ?? 1;
	}

	entityHeight(entity: { size?: number; height?: number }) {
		return entity.height ?? entity.size ?? 1;
	}

	private closestHit<T extends SelectableEntity>(x: number, y: number, candidates: T[]): T | null {
		let best: T | null = null;
		let bestDistance = Infinity;
		for (const entity of candidates) {
			const rect = this.renderedEntityRect(entity);
			const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
			if (!inside) continue;
			if (this.isResourceSouthTileClick(entity, x, y)) continue;
			const d = Math.hypot((rect.cx - x) / rect.width, (rect.cy - y) / rect.height);
			if (d < bestDistance) {
				best = entity;
				bestDistance = d;
			}
		}
		return best;
	}

	private isResourceSouthTileClick(entity: SelectableEntity, x: number, y: number) {
		if (entity.kind !== "resource") return false;
		const point = screenToIso(x, y, this.view.camera);
		const visualTile = { x: Math.round(point.x), y: Math.round(point.y) };
		const resourceTile = { x: Math.round(entity.x), y: Math.round(entity.y) };
		return visualTile.x + visualTile.y > resourceTile.x + resourceTile.y;
	}

	private renderedEntityRect(entity: SelectableEntity) {
		const bounds = spriteMetrics(entity.type);
		const scale = this.entityPixel(entity, this.view.camera.zoom || 1);
		const center = entity.kind === "building" || entity.kind === "resource" || entity.kind === "corpse"
			? isoToScreen(entity.x + (this.entityWidth(entity) - 1) / 2, entity.y + (this.entityHeight(entity) - 1) / 2, this.view.camera)
			: isoToScreen(entity.x + this.entityWidth(entity) / 2, entity.y + this.entityHeight(entity) / 2, this.view.camera);
		const visualWidth = bounds.width * scale;
		const visualHeight = bounds.height * scale;
		const footprintBottom = center.y + (this.entityHeight(entity) * TILE_H * (this.view.camera.zoom || 1)) / 2;
		const left = Math.round(center.x - visualWidth / 2 - bounds.minX * scale);
		const top = Math.round(footprintBottom - (bounds.maxY + 1) * scale);
		const pad = this.hitPadding(entity);
		const bottomPad = entity.kind === "resource" ? 0 : pad;
		return {
			left: left - pad,
			right: left + visualWidth + pad,
			top: top - pad,
			bottom: top + visualHeight + bottomPad,
			cx: left + visualWidth / 2,
			cy: top + visualHeight / 2,
			width: visualWidth,
			height: visualHeight,
		};
	}

	private forgetVisibleMissing(memory: Record<string, StaticMemoryEntity>, current: Record<string, Building | ResourceNode | Ruin>) {
		const visibility = this.state.snapshot?.visibility;
		if (!visibility) return;
		const mapSize = this.state.snapshot!.map.size;
		for (const [id, entity] of Object.entries(memory)) {
			if (!current[id] && this.isVisibleNow(visibility, entity.x, entity.y, this.entityWidth(entity), this.entityHeight(entity), mapSize)) delete memory[id];
		}
	}

	private isVisibleNow(visibility: GameState["snapshot"] extends infer _ ? NonNullable<GameState["snapshot"]>["visibility"] : never, x: number, y: number, width: number, height: number, mapSize: number) {
		const visible = visibility?.visibleSet;
		if (!visible) return false;
		for (let yy = Math.floor(y); yy < Math.ceil(y + height); yy += 1) {
			for (let xx = Math.floor(x); xx < Math.ceil(x + width); xx += 1) {
				if (visible.has(yy * mapSize + xx)) return true;
			}
		}
		return false;
	}

	private hitPadding(entity: { kind: string }) {
		const zoom = this.view.camera.zoom || 1;
		if (entity.kind === "building") return 10 * zoom;
		if (entity.kind === "resource") return 8 * zoom;
		return 5 * zoom;
	}

	private worldPixel(zoom: number) {
		return SCALE * zoom;
	}

	private entityPixel(_entity: SelectableEntity, zoom: number) {
		return this.worldPixel(zoom);
	}
}
