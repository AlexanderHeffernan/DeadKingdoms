import type { GameState, UIActions } from "./clientTypes.js";
import { AdminDashboard } from "./ui/adminDashboard.js";
import { AdminPopup } from "./ui/adminPopup.js";
import { BottomPanel } from "./ui/bottomPanel.js";
import type { GameUiComponent } from "./ui/component.js";
import { mustGet } from "./ui/dom.js";
import { HoverCard } from "./ui/hoverCard.js";
import { ResourcePanel } from "./ui/resources.js";
import { TopPanel } from "./ui/topPanel.js";

export class UI {
	private readonly state: GameState;
	private readonly components: GameUiComponent[];
	private readonly toast: HTMLElement;
	private lastToast = "";

	constructor(state: GameState, actions: UIActions) {
		this.state = state;
		const hoverCard = new HoverCard();
		const adminDashboard = new AdminDashboard({
			panel: mustGet("adminFullscreen"),
			level: mustGet("adminFullscreenLevel"),
			closeButton: mustGet("adminFullscreenCloseButton") as HTMLButtonElement,
			overviewTab: mustGet("adminOverviewTab") as HTMLButtonElement,
			performanceTab: mustGet("adminPerformanceTab") as HTMLButtonElement,
			playersTab: mustGet("adminPlayersTab") as HTMLButtonElement,
			logsTab: mustGet("adminLogsTab") as HTMLButtonElement,
			devCommandsTab: mustGet("adminDevCommandsTab") as HTMLButtonElement,
			overviewView: mustGet("adminOverviewView"),
			performanceView: mustGet("adminPerformanceView"),
			playersView: mustGet("adminPlayersView"),
			logsView: mustGet("adminLogsView"),
			devCommandsView: mustGet("adminDevCommandsView"),
			overviewMetrics: mustGet("adminOverviewMetrics"),
			overviewPlayers: mustGet("adminOverviewPlayers"),
			overviewEvents: mustGet("adminOverviewEvents"),
			overviewLogs: mustGet("adminOverviewLogs"),
			chart: mustGet("adminFullscreenChart") as HTMLCanvasElement,
			olderButton: mustGet("adminChartOlderButton") as HTMLButtonElement,
			newerButton: mustGet("adminChartNewerButton") as HTMLButtonElement,
			range: mustGet("adminChartRange") as HTMLSelectElement,
			windowLabel: mustGet("adminChartWindow"),
			playerTableBody: mustGet("adminPlayerTableBody") as HTMLTableSectionElement,
			logTableBody: mustGet("adminLogTableBody") as HTMLTableSectionElement,
			enableVisionButton: mustGet("adminEnableVisionButton") as HTMLButtonElement,
			enableSoundDebugButton: mustGet("adminEnableSoundDebugButton") as HTMLButtonElement,
			enableZombieDebugButton: mustGet("adminEnableZombieDebugButton") as HTMLButtonElement,
			spawnHordeButton: mustGet("adminSpawnHordeButton") as HTMLButtonElement,
			grantSoldiersButton: mustGet("adminGrantSoldiersButton") as HTMLButtonElement,
			invincibleButton: mustGet("adminInvincibleButton") as HTMLButtonElement,
			noiseToolButton: mustGet("adminNoiseToolButton") as HTMLButtonElement,
			commandStatus: mustGet("adminCommandStatus"),
		}, {
			enableFullMapVision: actions.enableFullMapVision,
			enableSoundDebug: actions.enableSoundDebug,
			enableZombieDebug: actions.enableZombieDebug,
			spawnHostileHorde: actions.spawnHostileHorde,
			grantSoldiers: actions.grantSoldiers,
			toggleTownCenterInvincible: actions.toggleTownCenterInvincible,
			toggleNoiseTool: actions.toggleNoiseTool,
		});
		this.components = [
			new ResourcePanel(state, mustGet("resources"), hoverCard),
			new TopPanel(state, mustGet("status"), mustGet("ping"), mustGet("serverPerf"), mustGet("leaderboard")),
			new AdminPopup({
				panel: mustGet("adminPanel"),
				heading: mustGet("adminHeading"),
				level: mustGet("adminLevel"),
				fullscreenButton: mustGet("adminFullscreenButton") as HTMLButtonElement,
				minimizeButton: mustGet("adminMinimizeButton") as HTMLButtonElement,
				restoreButton: mustGet("adminRestoreButton") as HTMLButtonElement,
				chart: mustGet("adminPerfChart") as HTMLCanvasElement,
				metrics: mustGet("adminMetrics"),
				players: mustGet("adminPlayers"),
				events: mustGet("adminEvents"),
			}, adminDashboard),
			new BottomPanel(state, actions, mustGet("selection"), mustGet("actions"), hoverCard),
		];
		this.toast = mustGet("toast");
	}

	render() {
		const snapshot = this.state.snapshot;
		if (!snapshot) return;
		for (const component of this.components) component.render(snapshot);
		const notice = snapshot.notices.at(-1)?.text || "";
		if (notice && notice !== this.lastToast) this.showToast(notice);
	}

	showToast(text: string) {
		this.lastToast = text;
		this.toast.textContent = text;
		this.toast.classList.add("visible");
		window.setTimeout(() => this.toast.classList.remove("visible"), 2400);
	}
}
