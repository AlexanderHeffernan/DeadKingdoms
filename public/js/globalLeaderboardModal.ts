import { getGlobalLeaderboard } from "./api.js";
import type { SnapshotPreview } from "./snapshotPreview.js";
import { escapeHtml } from "./ui/dom.js";
import type { GlobalLeaderboardEntry } from "../../src/shared/types.js";

export class GlobalLeaderboardModal {
	constructor(private readonly preview: SnapshotPreview) {}

	wireDom() {
		document.getElementById("homeLeaderboardButton")?.addEventListener("click", () => void this.open());
		document.getElementById("globalLeaderboardClose")?.addEventListener("click", () => this.close());
		document.getElementById("globalLeaderboardModal")?.addEventListener("mousedown", (event) => {
			if (event.target === event.currentTarget) this.close();
		});
	}

	async open() {
		const modal = document.getElementById("globalLeaderboardModal");
		const rows = document.getElementById("globalLeaderboardRows");
		if (!modal || !rows) return;
		modal.classList.remove("hidden");
		rows.innerHTML = `<div class="global-loading">Loading scores...</div>`;
		try {
			const result = await getGlobalLeaderboard();
			this.renderRows(result.entries || []);
		} catch {
			rows.innerHTML = `<div class="global-loading">Could not load the leaderboard.</div>`;
		}
	}

	close() {
		document.getElementById("globalLeaderboardModal")?.classList.add("hidden");
	}

	private renderRows(entries: GlobalLeaderboardEntry[]) {
		const rows = document.getElementById("globalLeaderboardRows");
		if (!rows) return;
		if (!entries.length) {
			rows.innerHTML = `<div class="global-loading">No scores recorded yet.</div>`;
			return;
		}
		rows.innerHTML = entries.map((entry, index) => `
			<div class="global-leaderboard-row">
				<span class="global-rank">#${index + 1}</span>
				<strong style="color: ${escapeHtml(entry.playerColor)}">${escapeHtml(entry.playerName)}</strong>
				<span class="global-leaderboard-stats">
					${this.score(entry)}
					${this.firstPlaceTime(entry)}
					${this.achievedDate(entry)}
				</span>
				<button type="button" data-snapshot-id="${escapeHtml(entry.snapshotId)}" data-player-id="${escapeHtml(entry.playerId)}">Preview</button>
			</div>
		`).join("");
		rows.querySelectorAll<HTMLButtonElement>("button[data-snapshot-id]").forEach((button) => {
			button.addEventListener("click", () => void this.preview.open(button.dataset.snapshotId || "", button.dataset.playerId || ""));
		});
		this.wireTooltips(rows);
	}

	private score(entry: GlobalLeaderboardEntry) {
		return `<em class="global-leaderboard-stat" tabindex="0" data-tooltip="Top score">${entry.score}</em>`;
	}

	private firstPlaceTime(entry: GlobalLeaderboardEntry) {
		const duration = entry.firstPlaceDurationMs ?? 0;
		if (duration <= 0) return "";
		return `<em class="global-leaderboard-stat" tabindex="0" data-tooltip="time #1">${this.durationClock(duration)}</em>`;
	}

	private achievedDate(entry: GlobalLeaderboardEntry) {
		const date = new Date(entry.achievedAt);
		if (Number.isNaN(date.getTime())) return "";
		return `<em class="global-leaderboard-stat" tabindex="0" data-tooltip="${escapeHtml(this.formatTime(date))}">${escapeHtml(this.formatDate(date))}</em>`;
	}

	private wireTooltips(container: HTMLElement) {
		container.querySelectorAll<HTMLElement>(".global-leaderboard-stat[data-tooltip]").forEach((stat) => {
			stat.addEventListener("mouseenter", () => this.showTooltip(stat));
			stat.addEventListener("focus", () => this.showTooltip(stat));
			stat.addEventListener("mouseleave", () => this.hideTooltip());
			stat.addEventListener("blur", () => this.hideTooltip());
		});
		container.addEventListener("scroll", () => this.hideTooltip());
	}

	private showTooltip(target: HTMLElement) {
		const text = target.dataset.tooltip;
		if (!text) return;
		const tooltip = this.tooltip();
		tooltip.textContent = text;
		tooltip.classList.add("visible");
		const rect = target.getBoundingClientRect();
		const tooltipRect = tooltip.getBoundingClientRect();
		const x = Math.min(window.innerWidth - tooltipRect.width - 8, Math.max(8, rect.right - tooltipRect.width));
		const y = Math.max(8, rect.top - tooltipRect.height - 8);
		tooltip.style.left = `${x}px`;
		tooltip.style.top = `${y}px`;
	}

	private hideTooltip() {
		document.getElementById("globalLeaderboardTooltip")?.classList.remove("visible");
	}

	private tooltip() {
		let tooltip = document.getElementById("globalLeaderboardTooltip");
		if (!tooltip) {
			tooltip = document.createElement("div");
			tooltip.id = "globalLeaderboardTooltip";
			tooltip.className = "global-leaderboard-popup";
			tooltip.setAttribute("role", "tooltip");
			document.body.appendChild(tooltip);
		}
		return tooltip;
	}

	private formatDate(date: Date) {
		return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}

	private formatTime(date: Date) {
		return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
	}

	private durationClock(durationMs: number) {
		const totalMinutes = Math.max(0, Math.floor(durationMs / 60000));
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
	}
}
