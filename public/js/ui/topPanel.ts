import type { GameState } from "../clientTypes.js";
import type { ClientSnapshot } from "../clientTypes.js";
import type { GameUiComponent } from "./component.js";
import { aliveTime, escapeHtml } from "./dom.js";

export class TopPanel implements GameUiComponent {
	private readonly state: GameState;
	private readonly status: HTMLElement;
	private readonly ping: HTMLElement;
	private readonly fps: HTMLElement;
	private readonly serverPerf: HTMLElement;
	private readonly leaderboard: HTMLElement;
	private leaderboardHtml = "";

	constructor(state: GameState, status: HTMLElement, ping: HTMLElement, fps: HTMLElement, serverPerf: HTMLElement, leaderboard: HTMLElement) {
		this.state = state;
		this.status = status;
		this.ping = ping;
		this.fps = fps;
		this.serverPerf = serverPerf;
		this.leaderboard = leaderboard;
	}

	render(snapshot: ClientSnapshot) {
		const player = this.state.playerId ? snapshot.players[this.state.playerId] : undefined;
		if (!player) return;
		this.status.textContent = player.defeated ? "Defeated" : "";
		const serverPerf = snapshot.serverPerf;
		const showAdminDiagnostics = snapshot.admin !== null && serverPerf !== null;
		this.ping.hidden = !showAdminDiagnostics;
		this.fps.hidden = !showAdminDiagnostics;
		this.serverPerf.hidden = !showAdminDiagnostics;
		if (showAdminDiagnostics) {
			this.ping.textContent = `Ping ${Math.max(0, Date.now() - snapshot.now)}ms`;
			this.serverPerf.textContent = `TPS ${Math.round(serverPerf.tps)} Tick ${serverPerf.tickMs.toFixed(1)}ms`;
		} else {
			this.ping.textContent = "";
			this.serverPerf.textContent = "";
		}
		const leaderboardHtml = snapshot.leaderboard
		.map((entry, index) => this.renderLeaderboardEntry(entry, index, snapshot.now))
		.join("");
		if (leaderboardHtml !== this.leaderboardHtml) {
			this.leaderboardHtml = leaderboardHtml;
			this.leaderboard.innerHTML = leaderboardHtml;
		}
	}

	private renderLeaderboardEntry(entry: ClientSnapshot["leaderboard"][number], index: number, now: number) {
		const rank = index + 1;
		const rankClass = rank <= 3 ? `rank-${rank}` : "rank-other";
		const timer = entry.firstPlaceSince ? ` <em class="leader-time" tabindex="0">${aliveTime(entry.firstPlaceSince, now)}<span class="leader-time-popup" role="tooltip">time #1</span></em>` : "";
		return `<li><span class="leader-rank ${rankClass}" title="${rankLabel(rank)}" aria-label="${rankLabel(rank)}">#${rank}</span> <span style="color:${entry.color}">${escapeHtml(entry.name)}</span> <strong>${entry.score}</strong>${timer}</li>`;
	}
}

function rankLabel(rank: number) {
	if (rank === 1) return "First place";
	if (rank === 2) return "Second place";
	if (rank === 3) return "Third place";
	return `Rank ${rank}`;
}
