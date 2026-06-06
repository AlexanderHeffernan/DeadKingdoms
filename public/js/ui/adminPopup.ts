import type { AdminSnapshot } from "../../../src/shared/types.js";
import type { ClientSnapshot } from "../clientTypes.js";
import type { GameUiComponent } from "./component.js";
import { escapeHtml, timeAgo } from "./dom.js";
import { AdminDashboard, drawSampleLine } from "./adminDashboard.js";

type AdminPointerMode = "drag" | "nw" | "ne" | "sw" | "se";

type AdminPointerStart = {
	mode: AdminPointerMode;
	startX: number;
	startY: number;
	left: number;
	top: number;
	width: number;
	height: number;
};

export class AdminPopup implements GameUiComponent {
	private readonly panel: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly level: HTMLElement;
	private readonly fullscreenButton: HTMLButtonElement;
	private readonly minimizeButton: HTMLButtonElement;
	private readonly restoreButton: HTMLButtonElement;
	private readonly chart: HTMLCanvasElement;
	private readonly metrics: HTMLElement;
	private readonly players: HTMLElement;
	private readonly events: HTMLElement;
	private readonly dashboard: AdminDashboard;
	private minimized = false;
	private currentAdmin: AdminSnapshot | null = null;
	private currentNow = Date.now();
	private pointerStart: AdminPointerStart | null = null;
	private readonly pointerMove = (event: PointerEvent) => this.movePanel(event);
	private readonly pointerEnd = () => this.endPointer();

	constructor(elements: AdminPopupElements, dashboard: AdminDashboard) {
		this.panel = elements.panel;
		this.heading = elements.heading;
		this.level = elements.level;
		this.fullscreenButton = elements.fullscreenButton;
		this.minimizeButton = elements.minimizeButton;
		this.restoreButton = elements.restoreButton;
		this.chart = elements.chart;
		this.metrics = elements.metrics;
		this.players = elements.players;
		this.events = elements.events;
		this.dashboard = dashboard;
		this.setupEvents();
	}

	render(snapshot: ClientSnapshot) {
		this.renderAdmin(snapshot.admin, snapshot.now);
	}

	private renderAdmin(admin: AdminSnapshot | null, now: number) {
		this.currentAdmin = admin;
		this.currentNow = now;
		if (!admin) {
			this.updateVisibility(false);
			this.dashboard.render(null, now);
			return;
		}
		this.updateVisibility(true);
		this.level.textContent = admin.level;
		this.metrics.innerHTML = `
<span>TPS <strong>${Math.round(admin.serverPerf.tps)}</strong></span>
<span>Tick <strong>${admin.serverPerf.tickMs.toFixed(1)}ms</strong></span>
<span>Players <strong>${admin.players.length}</strong></span>
`;
		this.players.innerHTML = admin.players.map((player) => `
<div class="admin-player">
	<span style="color:${player.color}">${escapeHtml(player.name)}</span>
	<strong>${player.connected ? "online" : "idle"}</strong>
	<em>${player.population}/${player.popCap} pop · ${player.score} score${player.ipAddress ? ` · ${escapeHtml(player.ipAddress)}` : ""}</em>
	<small>${player.lastSeenAt ? `seen ${timeAgo(now, player.lastSeenAt)}` : "not seen"}</small>
</div>
`).join("");
		this.events.innerHTML = admin.events
		.slice(-4)
		.map((event) => `<div><span>${timeAgo(now, event.at)}</span>${escapeHtml(event.text)}</div>`)
		.join("");
		this.drawChart(admin);
		this.dashboard.render(admin, now);
	}

	private setupEvents() {
		this.fullscreenButton.addEventListener("click", (event) => {
			event.preventDefault();
			if (this.currentAdmin) this.dashboard.show(this.currentAdmin, this.currentNow);
		});
		this.minimizeButton.addEventListener("click", (event) => {
			event.preventDefault();
			this.minimized = true;
			this.updateVisibility(true);
		});
		this.restoreButton.addEventListener("click", (event) => {
			event.preventDefault();
			this.minimized = false;
			this.updateVisibility(true);
		});
		this.heading.addEventListener("pointerdown", (event) => {
			if (event.target instanceof HTMLButtonElement) return;
			this.beginPointer(event, "drag");
		});
		for (const handle of Array.from(this.panel.querySelectorAll<HTMLElement>(".resize-handle"))) {
			const mode = handle.dataset.resize;
			if (!isAdminPointerMode(mode)) continue;
			handle.addEventListener("pointerdown", (event) => this.beginPointer(event, mode));
		}
	}

	private updateVisibility(hasAdminAccess: boolean) {
		if (!hasAdminAccess) {
			this.panel.classList.add("hidden");
			this.restoreButton.classList.add("hidden");
			this.dashboard.hide();
			return;
		}
		this.restoreButton.classList.toggle("hidden", !this.minimized);
		this.panel.classList.toggle("hidden", this.minimized);
		if (!this.minimized) this.constrainToViewport();
	}

	private beginPointer(event: PointerEvent, mode: AdminPointerMode) {
		if (this.minimized) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = this.panel.getBoundingClientRect();
		this.pointerStart = {
			mode,
			startX: event.clientX,
			startY: event.clientY,
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
		window.addEventListener("pointermove", this.pointerMove);
		window.addEventListener("pointerup", this.pointerEnd, { once: true });
		window.addEventListener("pointercancel", this.pointerEnd, { once: true });
	}

	private movePanel(event: PointerEvent) {
		const start = this.pointerStart;
		if (!start) return;
		event.preventDefault();
		const dx = event.clientX - start.startX;
		const dy = event.clientY - start.startY;
		const minWidth = 280;
		const minHeight = 260;
		let left = start.left;
		let top = start.top;
		let width = start.width;
		let height = start.height;
		if (start.mode === "drag") {
			left = start.left + dx;
			top = start.top + dy;
		} else {
			if (start.mode.includes("e")) width = start.width + dx;
			if (start.mode.includes("s")) height = start.height + dy;
			if (start.mode.includes("w")) {
				width = start.width - dx;
				left = start.left + dx;
			}
			if (start.mode.includes("n")) {
				height = start.height - dy;
				top = start.top + dy;
			}
		}
		const geometry = clampAdminPanelGeometry(left, top, width, height, minWidth, minHeight);
		this.applyGeometry(geometry.left, geometry.top, geometry.width, geometry.height);
	}

	private endPointer() {
		this.pointerStart = null;
		window.removeEventListener("pointermove", this.pointerMove);
	}

	private constrainToViewport() {
		const rect = this.panel.getBoundingClientRect();
		const geometry = clampAdminPanelGeometry(rect.left, rect.top, rect.width, rect.height, 280, 260);
		this.applyGeometry(geometry.left, geometry.top, geometry.width, geometry.height);
	}

	private applyGeometry(left: number, top: number, width: number, height: number) {
		this.panel.style.left = `${Math.round(left)}px`;
		this.panel.style.top = `${Math.round(top)}px`;
		this.panel.style.right = "auto";
		this.panel.style.width = `${Math.round(width)}px`;
		this.panel.style.height = `${Math.round(height)}px`;
	}

	private drawChart(admin: AdminSnapshot) {
		const ctx = this.chart.getContext("2d");
		if (!ctx) return;
		const width = this.chart.width;
		const height = this.chart.height;
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "#101410";
		ctx.fillRect(0, 0, width, height);
		ctx.strokeStyle = "rgb(244 239 230 / 0.16)";
		ctx.lineWidth = 1;
		for (let i = 1; i < 4; i += 1) {
			const y = Math.round((height / 4) * i);
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(width, y);
			ctx.stroke();
		}
		drawSampleLine(ctx, admin.serverPerf.samples, width, height, "tickMs", "#e9bd59");
		drawSampleLine(ctx, admin.serverPerf.samples, width, height, "tps", "#7ab6f0");
	}
}

function isAdminPointerMode(mode: string | undefined): mode is AdminPointerMode {
	return mode === "drag" || mode === "nw" || mode === "ne" || mode === "sw" || mode === "se";
}

function clampAdminPanelGeometry(
	left: number,
	top: number,
	width: number,
	height: number,
	minWidth: number,
	minHeight: number,
) {
	const viewportWidth = Math.max(minWidth, window.innerWidth);
	const viewportHeight = Math.max(minHeight, window.innerHeight);
	const maxWidth = Math.max(minWidth, viewportWidth - 24);
	const maxHeight = Math.max(minHeight, viewportHeight - 24);
	const clampedWidth = Math.min(Math.max(width, minWidth), maxWidth);
	const clampedHeight = Math.min(Math.max(height, minHeight), maxHeight);
	return {
		left: Math.min(Math.max(0, left), viewportWidth - clampedWidth),
		top: Math.min(Math.max(0, top), viewportHeight - clampedHeight),
		width: clampedWidth,
		height: clampedHeight,
	};
}

export type AdminPopupElements = {
	panel: HTMLElement;
	heading: HTMLElement;
	level: HTMLElement;
	fullscreenButton: HTMLButtonElement;
	minimizeButton: HTMLButtonElement;
	restoreButton: HTMLButtonElement;
	chart: HTMLCanvasElement;
	metrics: HTMLElement;
	players: HTMLElement;
	events: HTMLElement;
};
