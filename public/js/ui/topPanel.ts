import type { GameState } from "../clientTypes.js";
import type { ClientSnapshot } from "../clientTypes.js";
import type { GameUiComponent } from "./component.js";
import { aliveTime, escapeHtml } from "./dom.js";

export class TopPanel implements GameUiComponent {
	private readonly state: GameState;
	private readonly status: HTMLElement;
	private readonly ping: HTMLElement;
	private readonly serverPerf: HTMLElement;
	private readonly leaderboard: HTMLElement;

	constructor(state: GameState, status: HTMLElement, ping: HTMLElement, serverPerf: HTMLElement, leaderboard: HTMLElement) {
		this.state = state;
		this.status = status;
		this.ping = ping;
		this.serverPerf = serverPerf;
		this.leaderboard = leaderboard;
	}

	render(snapshot: ClientSnapshot) {
		const player = this.state.playerId ? snapshot.players[this.state.playerId] : undefined;
		if (!player) return;
		this.status.textContent = player.defeated ? "Defeated" : "";
		this.ping.textContent = `Ping ${Math.max(0, Date.now() - snapshot.now)}ms`;
		this.serverPerf.textContent = `TPS ${Math.round(snapshot.serverPerf.tps)} Tick ${snapshot.serverPerf.tickMs.toFixed(1)}ms`;
		this.leaderboard.innerHTML = snapshot.leaderboard
		.map((entry) => `<li><span style="color:${entry.color}">${escapeHtml(entry.name)}</span> <strong>${entry.score}</strong> <em>${aliveTime(entry.joinedAt, snapshot.now)}</em></li>`)
		.join("");
	}
}
