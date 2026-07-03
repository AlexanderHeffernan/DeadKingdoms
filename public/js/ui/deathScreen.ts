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
	) {
		playAgainButton.addEventListener("click", playAgain);
		exitButton.addEventListener("click", exitToMenu);
		hideButton.addEventListener("click", () => this.collapse());
		this.restoreButton.addEventListener("click", () => this.expand());
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

	private duration(totalSeconds: number) {
		const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
		const minutes = Math.floor(totalSeconds / 60) % 60;
		const hours = Math.floor(totalSeconds / 3600);
		return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
	}
}
