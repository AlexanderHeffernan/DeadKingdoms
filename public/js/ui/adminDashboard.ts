import type { AdminSnapshot, ServerPerfSample } from "../../../src/shared/types.js";
import { aliveTime, escapeHtml, formatClock, timeAgo } from "./dom.js";

const CHART_PLOT = { left: 96, top: 28, right: 32, bottom: 58 };
const UI_FONT = `"Red Alert INET", sans-serif`;

export class AdminDashboard {
	private readonly panel: HTMLElement;
	private readonly level: HTMLElement;
	private readonly closeButton: HTMLButtonElement;
	private readonly overviewTab: HTMLButtonElement;
	private readonly performanceTab: HTMLButtonElement;
	private readonly playersTab: HTMLButtonElement;
	private readonly logsTab: HTMLButtonElement;
	private readonly devCommandsTab: HTMLButtonElement;
	private readonly overviewView: HTMLElement;
	private readonly performanceView: HTMLElement;
	private readonly playersView: HTMLElement;
	private readonly logsView: HTMLElement;
	private readonly devCommandsView: HTMLElement;
	private readonly overviewMetrics: HTMLElement;
	private readonly overviewPlayers: HTMLElement;
	private readonly overviewEvents: HTMLElement;
	private readonly overviewLogs: HTMLElement;
	private readonly chart: HTMLCanvasElement;
	private readonly olderButton: HTMLButtonElement;
	private readonly newerButton: HTMLButtonElement;
	private readonly range: HTMLSelectElement;
	private readonly windowLabel: HTMLElement;
	private readonly playerTableBody: HTMLTableSectionElement;
	private readonly logTableBody: HTMLTableSectionElement;
	private readonly enableVisionButton: HTMLButtonElement;
	private readonly enableSoundDebugButton: HTMLButtonElement;
	private readonly enableZombieDebugButton: HTMLButtonElement;
	private readonly spawnHordeButton: HTMLButtonElement;
	private readonly grantSoldiersButton: HTMLButtonElement;
	private readonly invincibleButton: HTMLButtonElement;
	private readonly noiseToolButton: HTMLButtonElement;
	private readonly restartServerButton: HTMLButtonElement;
	private readonly commandStatus: HTMLElement;
	private readonly actions: AdminDashboardActions;
	private activeTab: AdminDashboardTab = "overview";
	private open = false;
	private rangeSeconds: number;
	private windowEndAt: number | null = null;
	private currentAdmin: AdminSnapshot | null = null;
	private currentNow = Date.now();
	private chartHoverRatio: number | null = null;

	constructor(elements: AdminDashboardElements, actions: AdminDashboardActions) {
		this.actions = actions;
		this.panel = elements.panel;
		this.level = elements.level;
		this.closeButton = elements.closeButton;
		this.overviewTab = elements.overviewTab;
		this.performanceTab = elements.performanceTab;
		this.playersTab = elements.playersTab;
		this.logsTab = elements.logsTab;
		this.devCommandsTab = elements.devCommandsTab;
		this.overviewView = elements.overviewView;
		this.performanceView = elements.performanceView;
		this.playersView = elements.playersView;
		this.logsView = elements.logsView;
		this.devCommandsView = elements.devCommandsView;
		this.overviewMetrics = elements.overviewMetrics;
		this.overviewPlayers = elements.overviewPlayers;
		this.overviewEvents = elements.overviewEvents;
		this.overviewLogs = elements.overviewLogs;
		this.chart = elements.chart;
		this.olderButton = elements.olderButton;
		this.newerButton = elements.newerButton;
		this.range = elements.range;
		this.windowLabel = elements.windowLabel;
		this.playerTableBody = elements.playerTableBody;
		this.logTableBody = elements.logTableBody;
		this.enableVisionButton = elements.enableVisionButton;
		this.enableSoundDebugButton = elements.enableSoundDebugButton;
		this.enableZombieDebugButton = elements.enableZombieDebugButton;
		this.spawnHordeButton = elements.spawnHordeButton;
		this.grantSoldiersButton = elements.grantSoldiersButton;
		this.invincibleButton = elements.invincibleButton;
		this.noiseToolButton = elements.noiseToolButton;
		this.restartServerButton = elements.restartServerButton;
		this.commandStatus = elements.commandStatus;
		this.rangeSeconds = Number(this.range.value) || 30;
		this.setupEvents();
	}

	show(admin: AdminSnapshot, now: number) {
		this.open = true;
		this.windowEndAt = null;
		this.render(admin, now);
	}

	hide() {
		this.open = false;
		this.panel.classList.add("hidden");
	}

	render(admin: AdminSnapshot | null, now: number) {
		this.currentAdmin = admin;
		this.currentNow = now;
		if (!admin || !this.open) {
			this.panel.classList.add("hidden");
			return;
		}
		this.panel.classList.remove("hidden");
		this.level.textContent = admin.level;
		this.renderOverview(admin, now);
		this.playerTableBody.innerHTML = admin.players.map((player) => `
<tr>
	<td><span class="admin-player-name" style="color:${player.color}">${escapeHtml(player.name)}</span></td>
	<td>${player.connected ? "Online" : "Idle"}${player.defeated ? " · Defeated" : ""}</td>
	<td>${player.population}/${player.popCap}</td>
	<td>${player.score}</td>
	<td>${formatPing(player.pingMs)}</td>
	<td>${aliveTime(player.joinedAt, now)}</td>
	<td>${player.connected ? "Online" : "Idle"}${player.defeated ? " · Defeated" : ""}</td>
	<td>${player.lastSeenAt ? timeAgo(now, player.lastSeenAt) : "not seen"}</td>
	<td>${escapeHtml(player.ipAddress ?? "restricted")}</td>
</tr>
`).join("");
		this.logTableBody.innerHTML = admin.logs
		.slice()
		.reverse()
		.map((entry) => `
<tr>
	<td>${formatClock(entry.at)}</td>
	<td>${escapeHtml(entry.source)}</td>
	<td>${escapeHtml(entry.message)}</td>
</tr>
`).join("");
		this.drawChart(admin.serverPerf.samples);
	}

	private setupEvents() {
		this.closeButton.addEventListener("click", (event) => {
			event.preventDefault();
			this.hide();
		});
		this.overviewTab.addEventListener("click", () => this.setActiveTab("overview"));
		this.performanceTab.addEventListener("click", () => this.setActiveTab("performance"));
		this.playersTab.addEventListener("click", () => this.setActiveTab("players"));
		this.logsTab.addEventListener("click", () => this.setActiveTab("logs"));
		this.devCommandsTab.addEventListener("click", () => this.setActiveTab("devCommands"));
		this.range.addEventListener("change", () => {
			this.rangeSeconds = Number(this.range.value) || 30;
			this.windowEndAt = null;
			this.render(this.currentAdmin, this.currentNow);
		});
		this.olderButton.addEventListener("click", () => this.panChart(-1));
		this.newerButton.addEventListener("click", () => this.panChart(1));
		this.chart.addEventListener("pointermove", (event) => this.updateChartHover(event));
		this.chart.addEventListener("pointerleave", () => {
			this.chartHoverRatio = null;
			if (this.currentAdmin) this.drawChart(this.currentAdmin.serverPerf.samples);
		});
		this.enableVisionButton.addEventListener("click", () => this.runCommand(this.enableVisionButton, this.actions.enableFullMapVision));
		this.enableSoundDebugButton.addEventListener("click", () => this.runCommand(this.enableSoundDebugButton, this.actions.enableSoundDebug));
		this.enableZombieDebugButton.addEventListener("click", () => this.runCommand(this.enableZombieDebugButton, this.actions.enableZombieDebug));
		this.spawnHordeButton.addEventListener("click", () => this.runCommand(this.spawnHordeButton, this.actions.spawnHostileHorde));
		this.grantSoldiersButton.addEventListener("click", () => this.runCommand(this.grantSoldiersButton, this.actions.grantSoldiers));
		this.invincibleButton.addEventListener("click", () => this.runCommand(this.invincibleButton, this.actions.toggleTownCenterInvincible));
		this.noiseToolButton.addEventListener("click", async () => {
			await this.runCommand(this.noiseToolButton, this.actions.toggleNoiseTool);
			this.hide();
		});
		this.restartServerButton.addEventListener("click", () => this.runCommand(this.restartServerButton, this.actions.restartServer));
	}

	private setActiveTab(tab: AdminDashboardTab) {
		this.activeTab = tab;
		const showingOverview = tab === "overview";
		const showingPerformance = tab === "performance";
		const showingPlayers = tab === "players";
		const showingLogs = tab === "logs";
		const showingDevCommands = tab === "devCommands";
		this.overviewTab.classList.toggle("active", showingOverview);
		this.performanceTab.classList.toggle("active", showingPerformance);
		this.playersTab.classList.toggle("active", showingPlayers);
		this.logsTab.classList.toggle("active", showingLogs);
		this.devCommandsTab.classList.toggle("active", showingDevCommands);
		this.overviewTab.setAttribute("aria-selected", String(showingOverview));
		this.performanceTab.setAttribute("aria-selected", String(showingPerformance));
		this.playersTab.setAttribute("aria-selected", String(showingPlayers));
		this.logsTab.setAttribute("aria-selected", String(showingLogs));
		this.devCommandsTab.setAttribute("aria-selected", String(showingDevCommands));
		this.overviewView.classList.toggle("hidden", !showingOverview);
		this.performanceView.classList.toggle("hidden", !showingPerformance);
		this.playersView.classList.toggle("hidden", !showingPlayers);
		this.logsView.classList.toggle("hidden", !showingLogs);
		this.devCommandsView.classList.toggle("hidden", !showingDevCommands);
		if (showingPerformance && this.currentAdmin) this.drawChart(this.currentAdmin.serverPerf.samples);
	}

	private async runCommand(button: HTMLButtonElement, command: () => Promise<string>) {
		button.disabled = true;
		this.commandStatus.textContent = "Running command...";
		try {
			this.commandStatus.textContent = await command();
		} catch {
			this.commandStatus.textContent = "Command failed.";
		} finally {
			button.disabled = false;
		}
	}

	private renderOverview(admin: AdminSnapshot, now: number) {
		const onlinePlayers = admin.players.filter((player) => player.connected).length;
		const defeatedPlayers = admin.players.filter((player) => player.defeated).length;
		this.overviewMetrics.innerHTML = `
<div><span>TPS</span><strong>${Math.round(admin.serverPerf.tps)}</strong></div>
<div><span>Tick</span><strong>${admin.serverPerf.tickMs.toFixed(1)}ms</strong></div>
<div><span>Players</span><strong>${onlinePlayers}/${admin.players.length}</strong></div>
<div><span>Defeated</span><strong>${defeatedPlayers}</strong></div>
<div><span>Logs</span><strong>${admin.logs.length}</strong></div>
`;
		this.overviewPlayers.innerHTML = admin.players
		.slice(0, 8)
		.map((player) => `<div><strong style="color:${player.color}">${escapeHtml(player.name)}</strong><span>${player.connected ? "online" : "idle"} · ${formatPing(player.pingMs)} · ${player.population}/${player.popCap} pop · ${player.score}</span></div>`)
		.join("");
		this.overviewEvents.innerHTML = admin.events
		.slice(-5)
		.reverse()
		.map((event) => `<div><strong>${timeAgo(now, event.at)}</strong><span>${escapeHtml(event.text)}</span></div>`)
		.join("");
		this.overviewLogs.innerHTML = admin.logs
		.slice(-6)
		.reverse()
		.map((entry) => `<div><strong>${formatClock(entry.at)} ${escapeHtml(entry.source)}</strong><span>${escapeHtml(entry.message)}</span></div>`)
		.join("");
	}

	private panChart(direction: -1 | 1) {
		const samples = this.currentAdmin?.serverPerf.samples ?? [];
		if (!samples.length) return;
		const latestAt = samples.at(-1)?.at ?? Date.now();
		const currentEndAt = this.windowEndAt ?? latestAt;
		this.windowEndAt = currentEndAt + direction * this.rangeSeconds * 500;
		this.render(this.currentAdmin, this.currentNow);
	}

	private drawChart(samples: ServerPerfSample[]) {
		const ctx = this.chart.getContext("2d");
		if (!ctx) return;
		const rect = this.chart.getBoundingClientRect();
		const scale = window.devicePixelRatio || 1;
		const width = Math.max(320, Math.floor(rect.width * scale));
		const height = Math.max(260, Math.floor(rect.height * scale));
		if (this.chart.width !== width) this.chart.width = width;
		if (this.chart.height !== height) this.chart.height = height;
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "#101410";
		ctx.fillRect(0, 0, width, height);
		const windowSamples = this.windowSamples(samples);
		drawChartGrid(ctx, width, height, windowSamples);
		drawSampleLine(ctx, windowSamples, width, height, "tickMs", "#e9bd59", CHART_PLOT);
		drawSampleLine(ctx, windowSamples, width, height, "tps", "#7ab6f0", CHART_PLOT);
		this.drawChartHover(ctx, windowSamples, width, height);
	}

	private updateChartHover(event: PointerEvent) {
		const rect = this.chart.getBoundingClientRect();
		this.chartHoverRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
		if (this.currentAdmin) this.drawChart(this.currentAdmin.serverPerf.samples);
	}

	private drawChartHover(ctx: CanvasRenderingContext2D, samples: ServerPerfSample[], width: number, height: number) {
		if (this.chartHoverRatio === null || samples.length < 1) return;
		const x = this.chartHoverRatio * width;
		const plotWidth = width - CHART_PLOT.left - CHART_PLOT.right;
		const plotX = Math.min(Math.max(x, CHART_PLOT.left), width - CHART_PLOT.right);
		const ratio = (plotX - CHART_PLOT.left) / Math.max(1, plotWidth);
		const index = Math.min(samples.length - 1, Math.max(0, Math.round(ratio * (samples.length - 1))));
		const sample = samples[index]!;
		const sampleX = CHART_PLOT.left + (index / Math.max(1, samples.length - 1)) * Math.max(1, plotWidth - 1);
		const tickY = sampleY(sample, samples, height, "tickMs", CHART_PLOT);
		const tpsY = sampleY(sample, samples, height, "tps", CHART_PLOT);
		ctx.save();
		ctx.strokeStyle = "rgb(244 239 230 / 0.55)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(sampleX, CHART_PLOT.top);
		ctx.lineTo(sampleX, height - CHART_PLOT.bottom);
		ctx.stroke();
		drawPoint(ctx, sampleX, tickY, "#e9bd59");
		drawPoint(ctx, sampleX, tpsY, "#7ab6f0");
		this.drawHoverTooltip(ctx, sample, sampleX, Math.min(tickY, tpsY), width);
		ctx.restore();
	}

	private drawHoverTooltip(ctx: CanvasRenderingContext2D, sample: ServerPerfSample, x: number, y: number, width: number) {
		const lines = [
			formatClock(sample.at),
			`Tick ${sample.tickMs.toFixed(2)}ms`,
			`TPS ${sample.tps.toFixed(2)}`,
			`#${sample.tick}`,
		];
		ctx.font = `16px ${UI_FONT}`;
		const padding = 10;
		const lineHeight = 21;
		const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + padding * 2;
		const boxHeight = lines.length * lineHeight + padding * 2;
		const boxX = Math.min(Math.max(8, x + 14), width - boxWidth - 8);
		const boxY = Math.max(8, y - boxHeight - 12);
		ctx.fillStyle = "rgb(17 20 17 / 0.96)";
		ctx.strokeStyle = "rgb(244 239 230 / 0.32)";
		ctx.lineWidth = 1;
		ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
		ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);
		lines.forEach((line, index) => {
			ctx.fillStyle = index === 1 ? "#e9bd59" : index === 2 ? "#7ab6f0" : "#f4efe6";
			ctx.fillText(line, boxX + padding, boxY + padding + 16 + index * lineHeight);
		});
	}

	private windowSamples(samples: ServerPerfSample[]) {
		if (!samples.length) {
			this.windowLabel.textContent = "No samples yet";
			this.olderButton.disabled = true;
			this.newerButton.disabled = true;
			return samples;
		}
		const firstAt = samples[0]!.at;
		const latestAt = samples.at(-1)!.at;
		const rangeMs = this.rangeSeconds * 1000;
		const maxEndAt = latestAt;
		const minEndAt = Math.min(latestAt, firstAt + rangeMs);
		const requestedEndAt = this.windowEndAt ?? maxEndAt;
		const endAt = Math.min(Math.max(requestedEndAt, minEndAt), maxEndAt);
		const startAt = Math.max(firstAt, endAt - rangeMs);
		this.windowEndAt = endAt === maxEndAt ? null : endAt;
		this.olderButton.disabled = startAt <= firstAt;
		this.newerButton.disabled = endAt >= maxEndAt;
		this.windowLabel.textContent = `${formatClock(startAt)} - ${formatClock(endAt)}`;
		return samples.filter((sample) => sample.at >= startAt && sample.at <= endAt);
	}
}

function drawChartGrid(ctx: CanvasRenderingContext2D, width: number, height: number, samples: ServerPerfSample[]) {
	const left = CHART_PLOT.left;
	const right = CHART_PLOT.right;
	const top = CHART_PLOT.top;
	const bottom = CHART_PLOT.bottom;
	ctx.strokeStyle = "rgb(244 239 230 / 0.16)";
	ctx.fillStyle = "#cfc7b7";
	ctx.font = `18px ${UI_FONT}`;
	ctx.lineWidth = 1;
	for (let i = 0; i <= 4; i += 1) {
		const y = top + ((height - top - bottom) / 4) * i;
		ctx.beginPath();
		ctx.moveTo(left, y);
		ctx.lineTo(width - right, y);
		ctx.stroke();
	}
	if (samples.length) {
		const firstAt = samples[0]!.at;
		const lastAt = samples.at(-1)!.at;
		for (let i = 0; i <= 4; i += 1) {
			const x = left + ((width - left - right) / 4) * i;
			const at = firstAt + ((lastAt - firstAt) / 4) * i;
			const label = formatClock(at);
			const labelWidth = ctx.measureText(label).width;
			const labelX = Math.min(Math.max(left, x - labelWidth / 2), width - right - labelWidth);
			ctx.fillText(label, labelX, height - 20);
			ctx.beginPath();
			ctx.moveTo(x, top);
			ctx.lineTo(x, height - bottom);
			ctx.stroke();
		}
	}
	ctx.save();
	ctx.fillStyle = "#e9bd59";
	ctx.translate(22, top + 86);
	ctx.rotate(-Math.PI / 2);
	ctx.fillText("Tick ms", 0, 0);
	ctx.restore();
	ctx.save();
	ctx.fillStyle = "#7ab6f0";
	ctx.translate(48, top + 58);
	ctx.rotate(-Math.PI / 2);
	ctx.fillText("TPS", 0, 0);
	ctx.restore();
}

function formatPing(pingMs: number | null) {
	return pingMs === null ? "--" : `${pingMs}ms`;
}

function sampleY(
	sample: ServerPerfSample,
	samples: ServerPerfSample[],
	height: number,
	key: "tickMs" | "tps",
	plot: { left: number; top: number; right: number; bottom: number },
) {
	const max = Math.max(1, ...samples.map((entry) => entry[key]));
	const plotHeight = height - plot.top - plot.bottom;
	return plot.top + plotHeight - (sample[key] / max) * Math.max(1, plotHeight);
}

function drawPoint(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
	ctx.fillStyle = color;
	ctx.strokeStyle = "#101410";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.arc(x, y, 5, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();
}

export function drawSampleLine(
	ctx: CanvasRenderingContext2D,
	samples: ServerPerfSample[],
	width: number,
	height: number,
	key: "tickMs" | "tps",
	color: string,
	plot = { left: 0, top: 0, right: 0, bottom: 0 },
) {
	if (samples.length < 2) return;
	const values = samples.map((sample) => sample[key]);
	const max = Math.max(1, ...values);
	const plotWidth = width - plot.left - plot.right;
	const plotHeight = height - plot.top - plot.bottom;
	ctx.strokeStyle = color;
	ctx.lineWidth = 2;
	ctx.beginPath();
	samples.forEach((sample, index) => {
		const x = plot.left + (index / (samples.length - 1)) * Math.max(1, plotWidth - 1);
		const y = plot.top + plotHeight - (sample[key] / max) * Math.max(1, plotHeight);
		if (index === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
	});
	ctx.stroke();
}

export type AdminDashboardElements = {
	panel: HTMLElement;
	level: HTMLElement;
	closeButton: HTMLButtonElement;
	overviewTab: HTMLButtonElement;
	performanceTab: HTMLButtonElement;
	playersTab: HTMLButtonElement;
	logsTab: HTMLButtonElement;
	devCommandsTab: HTMLButtonElement;
	overviewView: HTMLElement;
	performanceView: HTMLElement;
	playersView: HTMLElement;
	logsView: HTMLElement;
	devCommandsView: HTMLElement;
	overviewMetrics: HTMLElement;
	overviewPlayers: HTMLElement;
	overviewEvents: HTMLElement;
	overviewLogs: HTMLElement;
	chart: HTMLCanvasElement;
	olderButton: HTMLButtonElement;
	newerButton: HTMLButtonElement;
	range: HTMLSelectElement;
	windowLabel: HTMLElement;
	playerTableBody: HTMLTableSectionElement;
	logTableBody: HTMLTableSectionElement;
	enableVisionButton: HTMLButtonElement;
	enableSoundDebugButton: HTMLButtonElement;
	enableZombieDebugButton: HTMLButtonElement;
	spawnHordeButton: HTMLButtonElement;
	grantSoldiersButton: HTMLButtonElement;
	invincibleButton: HTMLButtonElement;
	noiseToolButton: HTMLButtonElement;
	restartServerButton: HTMLButtonElement;
	commandStatus: HTMLElement;
};

export type AdminDashboardActions = {
	enableFullMapVision: () => Promise<string>;
	enableSoundDebug: () => Promise<string>;
	enableZombieDebug: () => Promise<string>;
	spawnHostileHorde: () => Promise<string>;
	grantSoldiers: () => Promise<string>;
	toggleTownCenterInvincible: () => Promise<string>;
	toggleNoiseTool: () => Promise<string>;
	restartServer: () => Promise<string>;
};

type AdminDashboardTab = "overview" | "performance" | "players" | "logs" | "devCommands";
