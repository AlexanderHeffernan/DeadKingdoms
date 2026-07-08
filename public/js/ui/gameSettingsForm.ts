import type {
	GameSettingMetadata,
	GameSettings,
	GameSettingsMetadata,
	ResourceNumberMap,
} from "../../../src/shared/gameSettings.js";
import { escapeHtml } from "./dom.js";

type GameSettingsFormOptions = {
	title?: string;
	submitLabel?: string;
	values: GameSettings;
	currentValues?: GameSettings | null;
	onSubmit?: (patch: Partial<GameSettings>) => Promise<void> | void;
};

export class GameSettingsForm {
	private metadata: GameSettingsMetadata | null = null;
	private values: GameSettings | null = null;
	private currentValues: GameSettings | null = null;
	private onSubmit: ((patch: Partial<GameSettings>) => Promise<void> | void) | null = null;

	public constructor(private readonly container: HTMLElement) {}

	public render(metadata: GameSettingsMetadata, options: GameSettingsFormOptions) {
		this.metadata = metadata;
		this.values = options.values;
		this.currentValues = options.currentValues ?? null;
		this.onSubmit = options.onSubmit ?? null;
		const categories = this.groupByCategory(metadata.definitions);
		this.container.innerHTML = `
			<form class="game-settings-form">
				${options.title ? `<h2>${escapeHtml(options.title)}</h2>` : ""}
				${[...categories.entries()].map(([category, definitions]) => `
					<section>
						<h2>${escapeHtml(category)}</h2>
						${definitions.map((definition) => this.renderField(definition, options.values)).join("")}
					</section>
				`).join("")}
				${this.onSubmit ? `<button type="submit">${escapeHtml(options.submitLabel ?? "Save settings")}</button>` : ""}
			</form>
		`;
		this.container.querySelector("form")?.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.submit();
		});
	}

	public valuePatch(): Partial<GameSettings> {
		if (!this.metadata || !this.values) return {};
		const patch: Record<string, unknown> = {};
		for (const definition of this.metadata.definitions)
			patch[definition.key] = this.valueFor(definition);
		return patch as Partial<GameSettings>;
	}

	private async submit() {
		if (!this.onSubmit) return;
		await this.onSubmit(this.valuePatch());
	}

	private renderField(definition: GameSettingMetadata, values: GameSettings) {
		const id = this.inputId(definition.key);
		const current = this.currentValues ? this.currentValues[definition.key] : undefined;
		const changed = current !== undefined && JSON.stringify(current) !== JSON.stringify(values[definition.key]);
		const note = changed ? `<em>Applies next reset</em>` : "";
		return `
			<label class="game-setting-field ${definition.advanced ? "advanced" : ""}" for="${id}">
				<span>
					<strong>${escapeHtml(definition.label)}</strong>
					<small>${escapeHtml(definition.description)}</small>
					${note}
				</span>
				${this.renderInput(definition, values)}
			</label>
		`;
	}

	private renderInput(definition: GameSettingMetadata, values: GameSettings) {
		const value = values[definition.key];
		const id = this.inputId(definition.key);
		if (definition.kind === "number") {
			return `<input id="${id}" name="${escapeHtml(String(definition.key))}" type="number" min="${definition.min}" max="${definition.max}" step="${definition.step}" value="${escapeHtml(String(value))}" />`;
		}
		if (definition.kind === "numberChoice") {
			return `
				<select id="${id}" name="${escapeHtml(String(definition.key))}">
					${definition.options.map((option) => `
						<option value="${option}" ${option === value ? "selected" : ""}>${option}</option>
					`).join("")}
				</select>
			`;
		}
		const resources = value as ResourceNumberMap;
		return `
			<div id="${id}" class="game-setting-resource-grid">
				${definition.resources.map((resource) => `
					<label>
						<span>${escapeHtml(this.resourceLabel(resource))}</span>
						<input data-resource-setting="${escapeHtml(String(definition.key))}" data-resource="${escapeHtml(resource)}" type="number" min="${definition.min}" max="${definition.max}" step="${definition.step}" value="${escapeHtml(String(resources[resource]))}" />
					</label>
				`).join("")}
			</div>
		`;
	}

	private valueFor(definition: GameSettingMetadata) {
		if (definition.kind === "resourceNumber") {
			const values: Record<string, number> = {};
			for (const resource of definition.resources) {
				const input = this.container.querySelector<HTMLInputElement>(
					`[data-resource-setting="${definition.key}"][data-resource="${resource}"]`,
				);
				values[resource] = input ? Number(input.value) : definition.defaultValue[resource];
			}
			return values;
		}
		const input = this.container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${this.inputId(definition.key)}`);
		if (!input) return definition.defaultValue;
		return Number(input.value);
	}

	private groupByCategory(definitions: readonly GameSettingMetadata[]) {
		const groups = new Map<string, GameSettingMetadata[]>();
		for (const definition of definitions) {
			const group = groups.get(definition.category) ?? [];
			group.push(definition);
			groups.set(definition.category, group);
		}
		return groups;
	}

	private inputId(key: keyof GameSettings) {
		return `gameSetting-${String(key)}`;
	}

	private resourceLabel(resource: string) {
		return resource.slice(0, 1).toUpperCase() + resource.slice(1);
	}
}
