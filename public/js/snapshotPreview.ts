import { getGlobalLeaderboardSnapshot } from "./api.js";
import type { GameState, ViewState } from "./clientTypes.js";
import { isoToScreen, screenToIso } from "./iso.js";
import { Renderer } from "./render.js";
import type { SnapshotStore } from "./snapshotStore.js";
import type { Building, Corpse, PlayerId, ResourceNode, Unit } from "../../src/shared/types.js";

const ZOOM_STEPS = [0.2, 0.3, 0.4, 0.55, 0.75, 1, 1.25, 1.5, 1.75, 2];

type PreviewEntity = Unit | Building | ResourceNode | Corpse;

export class SnapshotPreview {
	private readonly canvas: HTMLCanvasElement | null;
	private readonly renderer: Renderer | null;
	private readonly state: GameState = {
		playerId: null,
		sessionToken: null,
		snapshot: null,
		selectedIds: new Set(),
		lastSeen: { buildings: {}, resources: {}, ruins: {} },
		effects: [],
		idleWorkerCycleIndex: -1,
		exploredSet: new Set(),
		timeOffsetSeconds: 0,
	};
	private readonly view: ViewState;
	private animation = 0;

	constructor(private readonly snapshots: SnapshotStore) {
		this.canvas = document.getElementById("snapshotPreviewCanvas") as HTMLCanvasElement | null;
		this.renderer = this.canvas ? new Renderer(this.canvas) : null;
		this.view = {
			camera: { x: 0, y: 0, zoom: 0.55 },
			dragging: false,
			panning: false,
			dragStart: null,
			dragCurrent: null,
			panLast: null,
			selectedIds: this.state.selectedIds,
			buildMode: null,
			rallyModeBuildingId: null,
			noiseMode: false,
			instantBuildMode: false,
			hoverTile: null,
			wallDragStartTile: null,
			mouse: { x: 0, y: 0 },
		};
	}

	wireDom() {
		document.getElementById("snapshotPreviewClose")?.addEventListener("click", () => this.close());
		document.getElementById("snapshotPreviewModal")?.addEventListener("mousedown", (event) => {
			if (event.target === event.currentTarget) this.close();
		});
		if (!this.canvas) return;
		this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
		this.canvas.addEventListener("mousedown", (event) => this.beginClick(event));
		this.canvas.addEventListener("mousemove", (event) => this.moveMouse(event));
		this.canvas.addEventListener("mouseup", (event) => this.endClick(event));
		this.canvas.addEventListener("mouseleave", () => {
			this.view.dragging = false;
			this.view.mouse = { x: -Infinity, y: -Infinity };
		});
		this.canvas.addEventListener("wheel", (event) => this.zoom(event), { passive: false });
	}

	async open(snapshotId: string, playerId?: PlayerId) {
		if (!snapshotId || !this.renderer || !this.canvas) return;
		const modal = document.getElementById("snapshotPreviewModal");
		const info = document.getElementById("snapshotPreviewInfo");
		modal?.classList.remove("hidden");
		this.setLoading(true);
		if (info) info.textContent = "Loading snapshot...";
		const result = await getGlobalLeaderboardSnapshot(snapshotId, playerId);
		if (!result.ok || !result.snapshot) {
			this.setLoading(false);
			if (info) info.textContent = result.error || "Could not load snapshot.";
			return;
		}
		this.state.snapshot = this.snapshots.hydratePreview(result.snapshot);
		this.state.playerId = result.snapshot.playerId;
		this.state.selectedIds.clear();
		this.view.camera.zoom = 1;
		this.renderer.resize();
		const rect = this.canvas.getBoundingClientRect();
		this.view.mouse = { x: rect.width / 2, y: rect.height / 2 };
		this.centerCamera();
		if (info) info.textContent = "Move the mouse to the edge to pan, scroll to zoom, click units and buildings to inspect.";
		this.setLoading(false);
		this.startLoop();
	}

	close() {
		document.getElementById("snapshotPreviewModal")?.classList.add("hidden");
		this.state.snapshot = null;
		this.state.selectedIds.clear();
		this.setLoading(false);
		if (this.animation) cancelAnimationFrame(this.animation);
		this.animation = 0;
	}

	private setLoading(loading: boolean) {
		document.getElementById("snapshotPreviewLoading")?.classList.toggle("hidden", !loading);
		this.canvas?.classList.toggle("snapshot-preview-canvas-loading", loading);
	}

	private startLoop() {
		if (this.animation) return;
		const draw = () => {
			if (!this.state.snapshot || document.getElementById("snapshotPreviewModal")?.classList.contains("hidden")) {
				this.animation = 0;
				return;
			}
			this.edgePan();
			this.renderer?.draw(this.state, this.view);
			this.animation = requestAnimationFrame(draw);
		};
		this.animation = requestAnimationFrame(draw);
	}

	private beginClick(event: MouseEvent) {
		this.view.dragging = true;
		this.view.dragStart = { x: event.clientX, y: event.clientY };
	}

	private moveMouse(event: MouseEvent) {
		if (!this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		this.view.mouse = {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
		};
	}

	private endClick(event: MouseEvent) {
		if (!this.view.dragging) return;
		this.view.dragging = false;
		const start = this.view.dragStart;
		this.view.dragStart = null;
		if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
		this.selectAt(event.clientX, event.clientY);
	}

	private zoom(event: WheelEvent) {
		event.preventDefault();
		if (!this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const before = screenToIso(x, y, this.view.camera);
		this.view.camera.zoom = this.nextZoom(this.view.camera.zoom!, event.deltaY < 0 ? 1 : -1);
		const after = isoToScreen(before.x, before.y, this.view.camera);
		this.view.camera.x += x - after.x;
		this.view.camera.y += y - after.y;
		this.clampCamera();
	}

	private selectAt(clientX: number, clientY: number) {
		if (!this.state.snapshot || !this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		const iso = screenToIso(clientX - rect.left, clientY - rect.top, this.view.camera);
		const hit = this.closestEntity(iso.x, iso.y);
		this.state.selectedIds.clear();
		if (hit) this.state.selectedIds.add(hit.id);
		const info = document.getElementById("snapshotPreviewInfo");
		if (info) info.textContent = hit ? `${this.labelForEntity(hit)} selected.` : "Move the mouse to the edge to pan, scroll to zoom, click units and buildings to inspect.";
	}

	private closestEntity(x: number, y: number) {
		const snapshot = this.state.snapshot;
		if (!snapshot) return null;
		const entities = [
			...Object.values(snapshot.units),
			...Object.values(snapshot.buildings),
			...Object.values(snapshot.resources),
			...Object.values(snapshot.corpses),
		];
		let best: PreviewEntity | null = null;
		let bestDistance = Infinity;
		for (const entity of entities) {
			const cx = entity.x + this.entityWidth(entity) / 2;
			const cy = entity.y + this.entityHeight(entity) / 2;
			const distance = Math.hypot(cx - x, cy - y);
			if (distance < bestDistance && distance < Math.max(1.2, this.entityWidth(entity), this.entityHeight(entity))) {
				best = entity;
				bestDistance = distance;
			}
		}
		return best;
	}

	private labelForEntity(entity: PreviewEntity) {
		if (entity.kind === "unit" || entity.kind === "building") {
			const owner = entity.ownerId ? this.state.snapshot?.players[entity.ownerId]?.name : null;
			return `${owner ? `${owner} ` : ""}${entity.type}`;
		}
		return entity.type;
	}

	private centerCamera() {
		if (!this.state.snapshot || !this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		const target = this.townCenter() ?? { x: this.state.snapshot.map.size / 2, y: this.state.snapshot.map.size / 2 };
		const center = isoToScreen(target.x, target.y, { x: 0, y: 0, zoom: this.view.camera.zoom });
		this.view.camera.x = rect.width / 2 - center.x;
		this.view.camera.y = rect.height / 2 - center.y;
		this.clampCamera();
	}

	private townCenter() {
		const snapshot = this.state.snapshot;
		if (!snapshot) return null;
		const town = Object.values(snapshot.buildings).find((building) => (
			building.type === "townCenter" &&
			(!this.state.playerId || building.ownerId === this.state.playerId)
		));
		if (!town) return null;
		return {
			x: town.x + (this.entityWidth(town) - 1) / 2,
			y: town.y + (this.entityHeight(town) - 1) / 2,
		};
	}

	private edgePan() {
		if (!this.state.snapshot || !this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		const mouse = this.view.mouse;
		if (mouse.x < 0 || mouse.y < 0 || mouse.x > rect.width || mouse.y > rect.height) return;
		const margin = 28;
		const speed = 10;
		if (mouse.x <= margin) this.view.camera.x += speed;
		if (mouse.x >= rect.width - margin) this.view.camera.x -= speed;
		if (mouse.y <= margin) this.view.camera.y += speed;
		if (mouse.y >= rect.height - margin) this.view.camera.y -= speed;
		this.clampCamera();
	}

	private clampCamera() {
		if (!this.state.snapshot || !this.canvas) return;
		const size = this.state.snapshot.map.size;
		const rect = this.canvas.getBoundingClientRect();
		const points = [
			isoToScreen(0, 0, { x: 0, y: 0, zoom: this.view.camera.zoom }),
			isoToScreen(size, 0, { x: 0, y: 0, zoom: this.view.camera.zoom }),
			isoToScreen(0, size, { x: 0, y: 0, zoom: this.view.camera.zoom }),
			isoToScreen(size, size, { x: 0, y: 0, zoom: this.view.camera.zoom }),
		];
		const minX = Math.min(...points.map((point) => point.x));
		const maxX = Math.max(...points.map((point) => point.x));
		const minY = Math.min(...points.map((point) => point.y));
		const maxY = Math.max(...points.map((point) => point.y));
		this.view.camera.x = this.clampAxis(this.view.camera.x, minX, maxX, maxX - minX, rect.width, 80);
		this.view.camera.y = this.clampAxis(this.view.camera.y, minY, maxY, maxY - minY, rect.height, 80);
	}

	private nextZoom(current: number, direction: number) {
		const index = ZOOM_STEPS.reduce((best, value, i) => (
			Math.abs(value - current) < Math.abs(ZOOM_STEPS[best]! - current) ? i : best
		), 0);
		return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))]!;
	}

	private clampAxis(cameraValue: number, mapMin: number, mapMax: number, mapSpan: number, viewSpan: number, margin: number) {
		if (mapSpan + margin * 2 <= viewSpan) return viewSpan / 2 - (mapMin + mapMax) / 2;
		const low = viewSpan - margin - mapMax;
		const high = margin - mapMin;
		return Math.max(low, Math.min(high, cameraValue));
	}

	private entityWidth(entity: { size?: number; width?: number }) {
		return entity.width ?? entity.size ?? 1;
	}

	private entityHeight(entity: { size?: number; height?: number }) {
		return entity.height ?? entity.size ?? 1;
	}
}
