export interface HotkeyAction {
	run: () => void;
	enabled: boolean;
}

declare const shortcutKeyBrand: unique symbol;
export type ShortcutKey = string & { readonly [shortcutKeyBrand]: true };

function parseShortcutKey(value: string): ShortcutKey | null {
	const normalized = value.toLowerCase();
	return normalized.length === 1 && !/\s/.test(normalized) ? normalized as ShortcutKey : null;
}

const STORAGE_KEY = "rtsActionHotkeys";
const DEFAULT_KEYS = ["q", "w", "e", "r", "a", "s", "d", "f", "z", "x", "c", "v"].map((key) => parseShortcutKey(key)!);

export class ActionHotkeys {
	private keys = this.loadKeys();
	private actions: HotkeyAction[] = [];
	private readonly changeListeners = new Set<() => void>();

	setActions(actions: HotkeyAction[]): void {
		this.actions = actions;
	}

	handleKeyDown(event: KeyboardEvent): boolean {
		if (!this.isEligible(event)) return false;
		const key = parseShortcutKey(event.key);
		if (!key) return false;
		const position = this.keys.indexOf(key);
		if (position < 0) return false;
		const action = this.actions[position];
		if (!action) return false;
		event.preventDefault();
		if (action.enabled) action.run();
		return true;
	}

	getKeys(): ShortcutKey[] {
		return [...this.keys];
	}

	getDisplayKey(position: number): string {
		return this.keys[position]?.toUpperCase() ?? "";
	}

	setKey(position: number, key: string): string | null {
		const shortcutKey = parseShortcutKey(key);
		if (!shortcutKey) return "Choose a letter, number, or punctuation key.";
		const duplicatePosition = this.keys.indexOf(shortcutKey);
		if (duplicatePosition >= 0 && duplicatePosition !== position) return `${shortcutKey.toUpperCase()} is already assigned.`;
		if (position < 0 || position >= this.keys.length) return "Unknown action position.";
		this.keys[position] = shortcutKey;
		this.saveAndNotify();
		return null;
	}

	reset() {
		this.keys = [...DEFAULT_KEYS];
		this.saveAndNotify();
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private isEligible(event: KeyboardEvent): boolean {
		if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return false;
		if (document.getElementById("game")?.classList.contains("hidden")) return false;
		if (!document.getElementById("settingsModal")?.classList.contains("hidden")) return false;
		return !(event.target instanceof HTMLElement && event.target.matches("input, textarea, select, button, [contenteditable='true']"));
	}

	private loadKeys(): ShortcutKey[] {
		try {
			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
			if (Array.isArray(stored) && stored.length === DEFAULT_KEYS.length && stored.every((key) => typeof key === "string")) {
				const keys = stored.map((key) => parseShortcutKey(key));
				if (keys.every((key): key is ShortcutKey => key !== null) && new Set(keys).size === keys.length) return keys;
			}
		} catch {
			// Ignore malformed local settings and restore the defaults.
		}
		return [...DEFAULT_KEYS];
	}

	private saveAndNotify(): void {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(this.keys));
		for (const listener of this.changeListeners) listener();
	}
}
