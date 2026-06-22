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
	private readonly bansTab: HTMLButtonElement;
	private readonly logsTab: HTMLButtonElement;
	private readonly devCommandsTab: HTMLButtonElement;
	private readonly overviewView: HTMLElement;
	private readonly performanceView: HTMLElement;
	private readonly perfBreakdown: HTMLElement;
	private readonly playersView: HTMLElement;
	private readonly bansView: HTMLElement;
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
	private readonly banTableBody: HTMLTableSectionElement;
	private readonly logTableBody: HTMLTableSectionElement;
	private readonly enableVisionButton: HTMLButtonElement;
	private readonly enableSoundDebugButton: HTMLButtonElement;
	private readonly enableZombieDebugButton: HTMLButtonElement;
	private readonly spawnHordeButton: HTMLButtonElement;
	private readonly grantSoldiersButton: HTMLButtonElement;
	private readonly invincibleButton: HTMLButtonElement;
	private readonly noiseToolButton: HTMLButtonElement;
	private readonly instantBuildButton: HTMLButtonElement;
	private readonly midnightButton: HTMLButtonElement;
	private readonly dawnButton: HTMLButtonElement;
	private readonly middayButton: HTMLButtonElement;
	private readonly eveningButton: HTMLButtonElement;
	private readonly disableAdminModeButton: HTMLButtonElement;
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
		this.bansTab = elements.bansTab;
		this.logsTab = elements.logsTab;
		this.devCommandsTab = elements.devCommandsTab;
		this.overviewView = elements.overviewView;
		this.performanceView = elements.performanceView;
		this.perfBreakdown = elements.perfBreakdown;
		this.playersView = elements.playersView;
		this.bansView = elements.bansView;
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
		this.banTableBody = elements.banTableBody;
		this.logTableBody = elements.logTableBody;
		this.enableVisionButton = elements.enableVisionButton;
		this.enableSoundDebugButton = elements.enableSoundDebugButton;
		this.enableZombieDebugButton = elements.enableZombieDebugButton;
		this.spawnHordeButton = elements.spawnHordeButton;
		this.grantSoldiersButton = elements.grantSoldiersButton;
		this.invincibleButton = elements.invincibleButton;
		this.noiseToolButton = elements.noiseToolButton;
		this.instantBuildButton = elements.instantBuildButton;
		this.midnightButton = elements.midnightButton;
		this.dawnButton = elements.dawnButton;
		this.middayButton = elements.middayButton;
		this.eveningButton = elements.eveningButton;
		this.disableAdminModeButton = elements.disableAdminModeButton;
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
		this.requestAdminView(this.activeTab);
		this.renderOverview(admin, now);
		this.renderPerfBreakdown(admin);
		const players = admin.players ?? [];
		const logs = admin.logs ?? [];
		this.playerTableBody.innerHTML = players.map((player) => `
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
	<td>
		<button type="button" data-admin-action="kick" data-player-id="${escapeHtml(player.id)}">Kick</button>
		<button type="button" data-admin-action="ban" data-player-id="${escapeHtml(player.id)}">Ban</button>
	</td>
</tr>
`).join("");
		this.banTableBody.innerHTML = (admin.bannedIpAddresses ?? [])
		.map((ipAddress) => `
<tr>
	<td>${escapeHtml(ipAddress)}</td>
	<td><button type="button" data-admin-action="unban" data-ip-address="${escapeHtml(ipAddress)}">Unban</button></td>
</tr>
`).join("");
		this.logTableBody.innerHTML = logs
		.slice()
		.reverse()
		.map((entry) => `
<tr>
	<td>${formatClock(entry.at)}</td>
	<td>${escapeHtml(entry.source)}</td>
	<td>${escapeHtml(entry.message)}</td>
</tr>
`).join("");
		if (admin.serverPerf) this.drawChart(admin.serverPerf.samples);
	}

	private setupEvents() {
		this.closeButton.addEventListener("click", (event) => {
			event.preventDefault();
			this.hide();
		});
		this.overviewTab.addEventListener("click", () => this.setActiveTab("overview"));
		this.performanceTab.addEventListener("click", () => this.setActiveTab("performance"));
		this.playersTab.addEventListener("click", () => this.setActiveTab("players"));
		this.bansTab.addEventListener("click", () => this.setActiveTab("bans"));
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
			if (this.currentAdmin?.serverPerf) this.drawChart(this.currentAdmin.serverPerf.samples);
		});
		this.playerTableBody.addEventListener("click", (event) => void this.handlePlayerAction(event));
		this.banTableBody.addEventListener("click", (event) => void this.handleBanAction(event));
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
		this.instantBuildButton.addEventListener("click", async () => {
			await this.runCommand(this.instantBuildButton, this.actions.toggleInstantBuild);
			this.hide();
		});
		this.midnightButton.addEventListener("click", () => this.runCommand(this.midnightButton, () => this.actions.setTimeOfDay(0, "Midnight")));
		this.dawnButton.addEventListener("click", () => this.runCommand(this.dawnButton, () => this.actions.setTimeOfDay(0.25, "Dawn")));
		this.middayButton.addEventListener("click", () => this.runCommand(this.middayButton, () => this.actions.setTimeOfDay(0.5, "Midday")));
		this.eveningButton.addEventListener("click", () => this.runCommand(this.eveningButton, () => this.actions.setTimeOfDay(0.75, "Evening")));
		this.disableAdminModeButton.addEventListener("click", async () => {
			await this.runCommand(this.disableAdminModeButton, this.actions.disableAdminMode);
			this.hide();
		});
		this.restartServerButton.addEventListener("click", () => this.runCommand(this.restartServerButton, this.actions.restartServer));
	}

	private setActiveTab(tab: AdminDashboardTab) {
		this.activeTab = tab;
		const showingOverview = tab === "overview";
		const showingPerformance = tab === "performance";
		const showingPlayers = tab === "players";
		const showingBans = tab === "bans";
		const showingLogs = tab === "logs";
		const showingDevCommands = tab === "devCommands";
		this.overviewTab.classList.toggle("active", showingOverview);
		this.performanceTab.classList.toggle("active", showingPerformance);
		this.playersTab.classList.toggle("active", showingPlayers);
		this.bansTab.classList.toggle("active", showingBans);
		this.logsTab.classList.toggle("active", showingLogs);
		this.devCommandsTab.classList.toggle("active", showingDevCommands);
		this.overviewTab.setAttribute("aria-selected", String(showingOverview));
		this.performanceTab.setAttribute("aria-selected", String(showingPerformance));
		this.playersTab.setAttribute("aria-selected", String(showingPlayers));
		this.bansTab.setAttribute("aria-selected", String(showingBans));
		this.logsTab.setAttribute("aria-selected", String(showingLogs));
		this.devCommandsTab.setAttribute("aria-selected", String(showingDevCommands));
		this.overviewView.classList.toggle("hidden", !showingOverview);
		this.performanceView.classList.toggle("hidden", !showingPerformance);
		this.playersView.classList.toggle("hidden", !showingPlayers);
		this.bansView.classList.toggle("hidden", !showingBans);
		this.logsView.classList.toggle("hidden", !showingLogs);
		this.devCommandsView.classList.toggle("hidden", !showingDevCommands);
		this.requestAdminView(tab);
		if (showingPerformance && this.currentAdmin?.serverPerf) this.drawChart(this.currentAdmin.serverPerf.samples);
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
		const players = admin.players ?? [];
		const logs = admin.logs ?? [];
		const events = admin.events ?? [];
		const perf = admin.serverPerf;
		const onlinePlayers = players.filter((player) => player.connected).length;
		const defeatedPlayers = players.filter((player) => player.defeated).length;
		this.overviewMetrics.innerHTML = `
<div><span>TPS</span><strong>${perf ? Math.round(perf.tps) : "--"}</strong></div>
<div><span>Tick</span><strong>${perf ? `${perf.tickMs.toFixed(1)}ms` : "--"}</strong></div>
<div><span>Players</span><strong>${onlinePlayers}/${players.length}</strong></div>
<div><span>Defeated</span><strong>${defeatedPlayers}</strong></div>
<div><span>Logs</span><strong>${logs.length}</strong></div>
`;
		this.overviewPlayers.innerHTML = players
		.slice(0, 8)
		.map((player) => `<div><strong style="color:${player.color}">${escapeHtml(player.name)}</strong><span>${player.connected ? "online" : "idle"} · ${formatPing(player.pingMs)} · ${player.population}/${player.popCap} pop · ${player.score}</span></div>`)
		.join("");
		this.overviewEvents.innerHTML = events
		.slice(-5)
		.reverse()
		.map((event) => `<div><strong>${timeAgo(now, event.at)}</strong><span>${escapeHtml(event.text)}</span></div>`)
		.join("");
		this.overviewLogs.innerHTML = logs
		.slice(-6)
		.reverse()
		.map((entry) => `<div><strong>${formatClock(entry.at)} ${escapeHtml(entry.source)}</strong><span>${escapeHtml(entry.message)}</span></div>`)
		.join("");
	}

	private renderPerfBreakdown(admin: AdminSnapshot) {
		if (!admin.serverPerf) {
			this.perfBreakdown.innerHTML = `<div class="admin-perf-empty">Open the Performance tab to load detailed samples.</div>`;
			return;
		}
		const phases = [...(admin.serverPerf.phases ?? [])].sort((a, b) => b.ms - a.ms);
		const unitAi = [...(admin.serverPerf.unitAi ?? [])].sort((a, b) => b.ms - a.ms);
		const zombies = admin.serverPerf.zombies;
		const worker = admin.serverPerf.zombieWorker;
		const zombieAiWorker = admin.serverPerf.zombieAiWorker;
		const zombieAiWorkerDetail = [...(zombieAiWorker?.detail ?? [])]
		.filter((bucket) => bucket.name !== "zombieStep")
		.sort((a, b) => b.ms - a.ms);
		const totalPhaseMs = phases.reduce((sum, phase) => sum + phase.ms, 0);
		const unitAiPhaseMs = phases.find((phase) => phase.name === "units")?.ms ?? 0;
		const unitAiDetailMs = unitAi.reduce((sum, bucket) => sum + bucket.ms, 0);
		const zombieSummary = zombies ? `
<div class="admin-perf-zombies">
	<span>Zombies</span>
	<strong>${zombies.stepped}/${zombies.total} stepped</strong>
	<em>${zombies.skipped} skipped · ${zombies.near} near · ${zombies.mid} mid · ${zombies.far} far</em>
</div>
` : "";
		const workerSummary = worker ? `
<div class="admin-perf-zombies">
	<span>Zombie director worker</span>
	<strong>${worker.mode}${worker.pending ? " pending" : ""}</strong>
	<em>${worker.lastDurationMs.toFixed(2)}ms · done ${worker.lastCompletedTick ?? "--"} · applied ${worker.lastAppliedTick ?? "--"} · failures ${worker.failures}${worker.lastError ? ` · ${escapeHtml(worker.lastError)}` : ""}</em>
</div>
` : "";
		const zombieAiWorkerSummary = zombieAiWorker ? `
<div class="admin-perf-zombies">
	<span>Zombie AI worker</span>
	<strong>${zombieAiWorker.mode}${zombieAiWorker.pending ? " pending" : ""}</strong>
	<em>${zombieAiWorker.lastDurationMs.toFixed(2)}ms · done ${zombieAiWorker.lastCompletedTick ?? "--"} · applied ${zombieAiWorker.lastAppliedTick ?? "--"} · failures ${zombieAiWorker.failures}${zombieAiWorker.lastError ? ` · ${escapeHtml(zombieAiWorker.lastError)}` : ""}</em>
</div>
` : "";
		this.perfBreakdown.innerHTML = `
<div class="admin-perf-summary">
	<div><span>Measured phases</span><strong>${totalPhaseMs.toFixed(1)}ms</strong></div>
	<div><span>Smoothed tick</span><strong>${admin.serverPerf.tickMs.toFixed(1)}ms</strong></div>
	${zombieSummary}
	${workerSummary}
	${zombieAiWorkerSummary}
</div>
<div class="admin-perf-phase-list">
${phases.map((phase) => `
	<div class="admin-perf-phase">
		<span>${escapeHtml(phase.label)}</span>
		<strong>${phase.ms.toFixed(2)}ms</strong>
		<em>${phase.percent.toFixed(0)}%</em>
		<i style="--phase-width:${Math.min(100, Math.max(1, phase.percent)).toFixed(1)}%"></i>
	</div>
`).join("") || `<div class="admin-perf-empty">No phase samples yet.</div>`}
</div>
${unitAi.length ? `
<div class="admin-perf-section-title">Unit AI detail · ${unitAiDetailMs.toFixed(2)}ms / ${unitAiPhaseMs.toFixed(2)}ms</div>
<div class="admin-perf-phase-list">
${unitAi.map((bucket) => `
	<div class="admin-perf-phase admin-perf-unit">
		<span>${escapeHtml(bucket.label)}</span>
		<strong>${bucket.ms.toFixed(2)}ms</strong>
		<em>${bucket.count} · ${bucket.averageMs.toFixed(3)}ms avg</em>
		<i style="--phase-width:${Math.min(100, Math.max(1, unitAiPhaseMs > 0 ? (bucket.ms / unitAiPhaseMs) * 100 : 1)).toFixed(1)}%"></i>
	</div>
`).join("")}
</div>
` : ""}
${zombieAiWorkerDetail.length ? `
<div class="admin-perf-section-title">Zombie AI worker detail · ${zombieAiWorkerDetail.reduce((sum, bucket) => sum + bucket.ms, 0).toFixed(2)}ms / ${zombieAiWorker?.lastDurationMs.toFixed(2) ?? "0.00"}ms</div>
<div class="admin-perf-phase-list">
${zombieAiWorkerDetail.map((bucket) => `
	<div class="admin-perf-phase admin-perf-unit">
		<span>${escapeHtml(bucket.label)}</span>
		<strong>${bucket.ms.toFixed(2)}ms</strong>
		<em>${bucket.count} · ${bucket.averageMs.toFixed(3)}ms avg</em>
		<i style="--phase-width:${Math.min(100, Math.max(1, zombieAiWorker && zombieAiWorker.lastDurationMs > 0 ? (bucket.ms / zombieAiWorker.lastDurationMs) * 100 : 1)).toFixed(1)}%"></i>
	</div>
`).join("")}
</div>
` : ""}
`;
	}

	private panChart(direction: -1 | 1) {
		const samples = this.currentAdmin?.serverPerf?.samples ?? [];
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
		if (this.currentAdmin?.serverPerf) this.drawChart(this.currentAdmin.serverPerf.samples);
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

	private async handlePlayerAction(event: Event) {
		const button = event.target instanceof HTMLButtonElement ? event.target : null;
		const action = button?.dataset.adminAction;
		const playerId = button?.dataset.playerId;
		if (!button || !playerId) return;
		if (action === "kick") await this.runCommand(button, () => this.actions.kickPlayer(playerId));
		if (action === "ban") await this.runCommand(button, () => this.actions.banPlayer(playerId));
	}

	private async handleBanAction(event: Event) {
		const button = event.target instanceof HTMLButtonElement ? event.target : null;
		const ipAddress = button?.dataset.ipAddress;
		if (!button || !ipAddress) return;
		await this.runCommand(button, () => this.actions.unbanIp(ipAddress));
	}

	private requestAdminView(tab: AdminDashboardTab) {
		window.dispatchEvent(new CustomEvent("admin-subscription", { detail: { view: tab } }));
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
	bansTab: HTMLButtonElement;
	logsTab: HTMLButtonElement;
	devCommandsTab: HTMLButtonElement;
	overviewView: HTMLElement;
	performanceView: HTMLElement;
	perfBreakdown: HTMLElement;
	playersView: HTMLElement;
	bansView: HTMLElement;
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
	banTableBody: HTMLTableSectionElement;
	logTableBody: HTMLTableSectionElement;
	enableVisionButton: HTMLButtonElement;
	enableSoundDebugButton: HTMLButtonElement;
	enableZombieDebugButton: HTMLButtonElement;
	spawnHordeButton: HTMLButtonElement;
	grantSoldiersButton: HTMLButtonElement;
	invincibleButton: HTMLButtonElement;
	noiseToolButton: HTMLButtonElement;
	instantBuildButton: HTMLButtonElement;
	midnightButton: HTMLButtonElement;
	dawnButton: HTMLButtonElement;
	middayButton: HTMLButtonElement;
	eveningButton: HTMLButtonElement;
	disableAdminModeButton: HTMLButtonElement;
	restartServerButton: HTMLButtonElement;
	commandStatus: HTMLElement;
};

export type AdminDashboardActions = {
	disableAdminMode: () => Promise<string>;
	enableFullMapVision: () => Promise<string>;
	enableSoundDebug: () => Promise<string>;
	enableZombieDebug: () => Promise<string>;
	kickPlayer: (targetPlayerId: string) => Promise<string>;
	banPlayer: (targetPlayerId: string) => Promise<string>;
	unbanIp: (ipAddress: string) => Promise<string>;
	spawnHostileHorde: () => Promise<string>;
	grantSoldiers: () => Promise<string>;
	toggleTownCenterInvincible: () => Promise<string>;
	toggleNoiseTool: () => Promise<string>;
	toggleInstantBuild: () => Promise<string>;
	setTimeOfDay: (progress: number, label: string) => Promise<string>;
	restartServer: () => Promise<string>;
};

type AdminDashboardTab = "overview" | "performance" | "players" | "logs" | "devCommands" | "bans";
