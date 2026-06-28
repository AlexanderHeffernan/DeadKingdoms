import { createTutorialItems } from "./tutorialItems.js";
import type { TutorialEvent, TutorialItem } from "./tutorialItem.js";

const TUTORIAL_COMPLETE_STORAGE_KEY = "deadKingdoms.tutorialComplete";

export class TutorialController {
	private items: TutorialItem[];
	private active = false;
	private completedThisSession = false;
	private completionTimer: number | null = null;

	constructor(
		private readonly panel: HTMLElement,
		private readonly list: HTMLElement,
		private readonly skipButton: HTMLButtonElement,
		private readonly collapseButton: HTMLButtonElement,
		private readonly content: HTMLElement,
	) {
		this.items = createTutorialItems();
		this.skipButton.addEventListener("click", () => this.finish());
		this.collapseButton.addEventListener("click", () => this.toggleCollapsed());
	}

	start() {
		if (this.completedThisSession || this.hasCompletedTutorial()) return;
		this.active = true;
		this.render();
		this.panel.classList.remove("hidden");
	}

	restart() {
		if (this.completionTimer !== null) window.clearTimeout(this.completionTimer);
		this.completionTimer = null;
		this.forgetCompletion();
		this.completedThisSession = false;
		this.items = createTutorialItems();
		this.start();
	}

	handleEvent(event: TutorialEvent) {
		if (!this.active) return;
		for (const item of this.items) item.update(event);
		this.render();
		if (this.items.every((item) => item.isComplete()) && this.completionTimer === null) {
			this.completionTimer = window.setTimeout(() => this.finish(), 700);
		}
	}

	private render() {
		this.list.replaceChildren(...this.items.map((item) => this.renderItem(item)));
	}

	private toggleCollapsed() {
		const collapsed = !this.content.classList.contains("hidden");
		this.content.classList.toggle("hidden", collapsed);
		this.panel.classList.toggle("collapsed", collapsed);
		this.collapseButton.textContent = collapsed ? "+" : "−";
		this.collapseButton.setAttribute("aria-expanded", String(!collapsed));
		this.collapseButton.setAttribute("aria-label", collapsed ? "Expand tutorial" : "Collapse tutorial");
	}

	private renderItem(item: TutorialItem) {
		const row = document.createElement("li");
		row.classList.toggle("complete", item.isComplete());

		const check = document.createElement("span");
		check.className = "tutorial-check";
		check.setAttribute("aria-hidden", "true");

		const text = document.createElement("span");
		text.textContent = item.getText();
		row.append(check, text);
		return row;
	}

	private finish() {
		if (!this.active) return;
		this.active = false;
		this.completionTimer = null;
		this.completedThisSession = true;
		this.rememberCompletion();
		this.panel.classList.add("hidden");
	}

	private hasCompletedTutorial() {
		try {
			return window.localStorage.getItem(TUTORIAL_COMPLETE_STORAGE_KEY) === "true";
		} catch {
			return false;
		}
	}

	private rememberCompletion() {
		try {
			window.localStorage.setItem(TUTORIAL_COMPLETE_STORAGE_KEY, "true");
		} catch {
			// The tutorial still finishes for this session when storage is unavailable.
		}
	}

	private forgetCompletion() {
		try {
			window.localStorage.removeItem(TUTORIAL_COMPLETE_STORAGE_KEY);
		} catch {
			// Restarting still works for this session when storage is unavailable.
		}
	}
}
