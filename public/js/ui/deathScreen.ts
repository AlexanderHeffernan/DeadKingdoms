import type { PlayerStatisticsSnapshot } from "../../../src/shared/types.js";
import type { HoverCard } from "./hoverCard.js";

type StatisticRow = [label: string, value: string | number, description: string];

export class DeathScreen {
	private currentReport: PlayerStatisticsSnapshot | null = null;

	constructor(
		private readonly panel: HTMLElement,
		private readonly statistics: HTMLElement,
		playAgainButton: HTMLButtonElement,
		playAgain: () => void,
		exitButton: HTMLButtonElement,
		exitToMenu: () => void,
		hideButton: HTMLButtonElement,
		private readonly restoreButton: HTMLButtonElement,
		private readonly hoverCard: HoverCard,
		private readonly summaryTab: HTMLButtonElement,
		private readonly scoreTab: HTMLButtonElement,
		private readonly summaryView: HTMLElement,
		private readonly scoreView: HTMLElement,
		private readonly scoreChart: HTMLCanvasElement,
		private readonly finalScore: HTMLElement,
	) {
		playAgainButton.addEventListener("click", playAgain);
		exitButton.addEventListener("click", exitToMenu);
		hideButton.addEventListener("click", () => this.collapse());
		this.restoreButton.addEventListener("click", () => this.expand());
		this.summaryTab.addEventListener("click", () => this.selectTab("summary"));
		this.scoreTab.addEventListener("click", () => this.selectTab("score"));
	}

	show(report: PlayerStatisticsSnapshot) {
		if (report === this.currentReport) return;
		this.currentReport = report;
		this.statistics.innerHTML = [
			this.section("Military", [
				["Units killed", report.military.unitsKilled, "Enemy units killed by your units and buildings."],
				["Units lost", report.military.unitsLost, "Your units lost in combat."],
				["Buildings razed", report.military.buildingsRazed, "Enemy buildings destroyed by your forces."],
				["Buildings lost", report.military.buildingsLost, "Your buildings destroyed by enemy attacks."],
				["Largest army", report.military.largestArmy, "The greatest number of military units you controlled at once."],
			]),
			this.section("Economy", [
				["Wood collected", report.economy.resourcesCollected.wood, "Wood successfully deposited into your stockpile."],
				["Food collected", report.economy.resourcesCollected.food, "Food successfully deposited into your stockpile."],
				["Ore collected", report.economy.resourcesCollected.ore, "Ore successfully deposited into your stockpile."],
			]),
			this.section("Kingdom", [
				["Survived", this.duration(report.durationSeconds), "How long your kingdom lasted."],
				["Villager high", report.economy.villagerHigh, "The greatest number of villagers you controlled at once."],
				["Villager utilisation", `${Math.round(report.economy.villagerUtilisation * 100)}%`, "The percentage of total villager time spent assigned to work."],
			]),
		].join("");
		this.attachTooltips();
		this.drawScoreChart(report);
		this.selectTab("summary");
		this.panel.classList.remove("hidden");
	}

	hide() {
		this.currentReport = null;
		this.panel.classList.add("hidden");
		this.restoreButton.classList.add("hidden");
	}

	private collapse() {
		this.panel.classList.add("hidden");
		this.restoreButton.classList.remove("hidden");
	}

	private expand() {
		this.panel.classList.remove("hidden");
		this.restoreButton.classList.add("hidden");
	}

	private section(title: string, rows: StatisticRow[]) {
		return `<section class="death-stat-section"><h3>${title}</h3>${rows.map(([label, value, description]) => `<div class="death-stat-row" data-hover-title="${label}" data-hover-detail="${description}"><span>${label}</span><strong>${value}</strong></div>`).join("")}</section>`;
	}

	private attachTooltips() {
		for (const row of Array.from(this.statistics.querySelectorAll<HTMLElement>(".death-stat-row"))) {
			row.addEventListener("mouseenter", () => this.hoverCard.showInfo(row));
			row.addEventListener("mousemove", () => this.hoverCard.showInfo(row));
			row.addEventListener("mouseleave", () => this.hoverCard.hide());
		}
	}

	private selectTab(tab: "summary" | "score") {
		const showSummary = tab === "summary";
		this.summaryTab.classList.toggle("active", showSummary);
		this.scoreTab.classList.toggle("active", !showSummary);
		this.summaryView.classList.toggle("hidden", !showSummary);
		this.scoreView.classList.toggle("hidden", showSummary);
	}

	private drawScoreChart(report: PlayerStatisticsSnapshot) {
		const context = this.scoreChart.getContext("2d");
		if (!context) return;
		const samples = report.scoreHistory.length > 0 ? report.scoreHistory : [{ atSeconds: 0, score: 0 }];
		const width = this.scoreChart.width;
		const height = this.scoreChart.height;
		const padding = 34;
		const maxTime = Math.max(1, report.durationSeconds, ...samples.map((sample) => sample.atSeconds));
		const maxScore = Math.max(1, ...samples.map((sample) => sample.score));
		context.clearRect(0, 0, width, height);
		context.strokeStyle = "#3a3027";
		context.lineWidth = 2;
		for (let line = 0; line <= 4; line += 1) {
			const y = padding + ((height - padding * 2) * line) / 4;
			context.beginPath();
			context.moveTo(padding, y);
			context.lineTo(width - padding, y);
			context.stroke();
		}
		context.strokeStyle = "#e9bd59";
		context.lineWidth = 4;
		context.beginPath();
		samples.forEach((sample, index) => {
			const x = padding + (sample.atSeconds / maxTime) * (width - padding * 2);
			const y = height - padding - (sample.score / maxScore) * (height - padding * 2);
			if (index === 0) context.moveTo(x, y);
			else context.lineTo(x, y);
		});
		context.stroke();
		context.fillStyle = "#bdb3a3";
		context.font = "16px sans-serif";
		context.fillText("0", 10, height - padding + 5);
		context.fillText(String(maxScore), 6, padding + 5);
		context.fillText(this.duration(maxTime), width - 78, height - 8);
		this.finalScore.textContent = `Final score: ${samples.at(-1)?.score ?? 0}`;
	}

	private duration(totalSeconds: number) {
		const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
		const minutes = Math.floor(totalSeconds / 60) % 60;
		const hours = Math.floor(totalSeconds / 3600);
		return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
	}
}
