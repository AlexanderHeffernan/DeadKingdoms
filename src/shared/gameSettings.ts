import {
	MAP_SIZE,
	MAX_PLAYERS,
	RESOURCE_TYPES,
} from "./config.js";
import type { ResourceType } from "./types/core.js";

export type GameSettingsScope = "publicAdmin" | "privateHost";

export type ResourceNumberMap = Record<ResourceType, number>;

export interface GameSettings {
	mapSize: number;
	maxPlayers: number;
	gameSpeed: number;
	zombieSpawnRate: number;
	resourceDensity: ResourceNumberMap;
}

export type GameSettingsPatch = Partial<GameSettings>;

export interface GameSettingsAccessor {
	get mapSize(): number;
	get maxPlayers(): number;
	get gameSpeed(): number;
	get zombieSpawnRate(): number;
	get resourceDensity(): ResourceNumberMap;
	toGameSettings(): GameSettings;
}

export type GameSettingMetadata =
	| NumberGameSettingMetadata
	| NumberChoiceGameSettingMetadata
	| ResourceNumberGameSettingMetadata;

export interface BaseGameSettingMetadata {
	key: keyof GameSettings;
	label: string;
	description: string;
	category: string;
	advanced: boolean;
}

export interface NumberGameSettingMetadata extends BaseGameSettingMetadata {
	kind: "number";
	defaultValue: number;
	min: number;
	max: number;
	step: number;
}

export interface NumberChoiceGameSettingMetadata extends BaseGameSettingMetadata {
	kind: "numberChoice";
	defaultValue: number;
	options: readonly NumberChoice[];
}

export interface NumberChoice {
	value: number;
	label: string;
}

export interface ResourceNumberGameSettingMetadata
	extends BaseGameSettingMetadata {
	kind: "resourceNumber";
	defaultValue: ResourceNumberMap;
	options: readonly NumberChoice[];
	resources: readonly ResourceType[];
}

export interface GameSettingsMetadata {
	definitions: GameSettingMetadata[];
}

type EnvSource = Record<string, string | undefined>;

type GameSettingOptions<T> = {
	key: keyof GameSettings;
	label: string;
	description: string;
	category: string;
	defaultValue: T;
	env?: string;
	scopes: readonly GameSettingsScope[];
	advanced?: boolean;
};

abstract class GameSetting<T> {
	public readonly key: keyof GameSettings;
	public readonly label: string;
	public readonly description: string;
	public readonly category: string;
	public readonly defaultValue: T;
	public readonly env: string | null;
	public readonly scopes: readonly GameSettingsScope[];
	public readonly advanced: boolean;

	public constructor(options: GameSettingOptions<T>) {
		this.key = options.key;
		this.label = options.label;
		this.description = options.description;
		this.category = options.category;
		this.defaultValue = options.defaultValue;
		this.env = options.env ?? null;
		this.scopes = options.scopes;
		this.advanced = options.advanced ?? false;
	}

	public appliesTo(scope: GameSettingsScope) {
		return this.scopes.includes(scope);
	}

	public fromEnv(env: EnvSource): T {
		if (!this.env) return this.default();
		const value = env[this.env];
		return value === undefined || value === ""
			? this.default()
			: this.normalize(value);
	}

	public default(): T {
		return this.clone(this.defaultValue);
	}

	public abstract normalize(value: unknown): T;
	public abstract metadata(): GameSettingMetadata;

	protected clone(value: T): T {
		if (value && typeof value === "object")
			return { ...(value as Record<string, unknown>) } as T;
		return value;
	}
}

class NumberGameSetting extends GameSetting<number> {
	public readonly min: number;
	public readonly max: number;
	public readonly step: number;

	public constructor(options: GameSettingOptions<number> & {
		min: number;
		max: number;
		step: number;
	}) {
		super(options);
		this.min = options.min;
		this.max = options.max;
		this.step = options.step;
	}

	public normalize(value: unknown): number {
		const parsed = typeof value === "number" ? value : Number(value);
		const finite = Number.isFinite(parsed) ? parsed : this.defaultValue;
		const stepped = this.step > 0
			? Math.round(finite / this.step) * this.step
			: finite;
		return Number(Math.min(this.max, Math.max(this.min, stepped)).toFixed(4));
	}

	public metadata(): NumberGameSettingMetadata {
		return {
			kind: "number",
			key: this.key,
			label: this.label,
			description: this.description,
			category: this.category,
			defaultValue: this.defaultValue,
			min: this.min,
			max: this.max,
			step: this.step,
			advanced: this.advanced,
		};
	}
}

class NumberChoiceGameSetting extends GameSetting<number> {
	public readonly options: readonly NumberChoice[];

	public constructor(options: GameSettingOptions<number> & {
		options: readonly NumberChoice[];
	}) {
		super(options);
		this.options = [...options.options].sort((a, b) => a.value - b.value);
	}

	public normalize(value: unknown): number {
		const parsed = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(parsed)) return this.defaultValue;
		return this.options.reduce((best, option) =>
			Math.abs(option.value - parsed) < Math.abs(best - parsed) ? option.value : best,
			this.options[0]?.value ?? this.defaultValue,
		);
	}

	public metadata(): NumberChoiceGameSettingMetadata {
		return {
			kind: "numberChoice",
			key: this.key,
			label: this.label,
			description: this.description,
			category: this.category,
			defaultValue: this.defaultValue,
			options: this.options,
			advanced: this.advanced,
		};
	}
}

class ResourceNumberGameSetting extends GameSetting<ResourceNumberMap> {
	public readonly options: readonly NumberChoice[];
	public readonly envPrefix: string | null;

	public constructor(options: Omit<GameSettingOptions<ResourceNumberMap>, "env"> & {
		envPrefix?: string;
		options: readonly NumberChoice[];
	}) {
		super(options);
		this.envPrefix = options.envPrefix ?? null;
		this.options = [...options.options].sort((a, b) => a.value - b.value);
	}

	public override fromEnv(env: EnvSource): ResourceNumberMap {
		const values = this.default();
		if (!this.envPrefix) return values;
		for (const resource of RESOURCE_TYPES) {
			const value = env[`${this.envPrefix}_${resource.toUpperCase()}`];
			if (value !== undefined && value !== "")
				values[resource] = this.normalizeNumber(value);
		}
		return values;
	}

	public normalize(value: unknown): ResourceNumberMap {
		const normalized = this.default();
		if (!value || typeof value !== "object") return normalized;
		const record = value as Partial<Record<ResourceType, unknown>>;
		for (const resource of RESOURCE_TYPES) {
			if (record[resource] !== undefined)
				normalized[resource] = this.normalizeNumber(record[resource]);
		}
		return normalized;
	}

	public metadata(): ResourceNumberGameSettingMetadata {
		return {
			kind: "resourceNumber",
			key: this.key,
			label: this.label,
			description: this.description,
			category: this.category,
			defaultValue: this.default(),
			options: this.options,
			resources: RESOURCE_TYPES,
			advanced: this.advanced,
		};
	}

	private normalizeNumber(value: unknown): number {
		const parsed = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(parsed)) return 1;
		return this.options.reduce((best, option) =>
			Math.abs(option.value - parsed) < Math.abs(best - parsed) ? option.value : best,
			this.options[0]?.value ?? 1,
		);
	}
}

export class GameSettingsRegistry {
	private readonly settings: readonly GameSetting<unknown>[];

	public constructor(definitions: readonly GameSetting<unknown>[]) {
		this.settings = definitions;
	}

	public defaults(): GameSettings {
		return this.fromEntries((setting) => setting.default());
	}

	public fromEnv(env: EnvSource): GameSettings {
		return this.fromEntries((setting) => setting.fromEnv(env));
	}

	public normalize(raw: Partial<GameSettings> = {}): GameSettings {
		return this.fromEntries((setting) =>
			raw[setting.key] === undefined
				? setting.default()
				: setting.normalize(raw[setting.key]),
		);
	}

	public parsePatch(raw: unknown): GameSettingsPatch {
		if (!raw || typeof raw !== "object") return {};
		const patch: Record<string, unknown> = {};
		for (const setting of this.settings) {
			const value = (raw as Record<string, unknown>)[setting.key];
			if (value !== undefined) patch[setting.key] = setting.normalize(value);
		}
		return patch as GameSettingsPatch;
	}

	public merge(base: GameSettings, patch: GameSettingsPatch): GameSettings {
		return this.normalize({ ...base, ...patch });
	}

	public fromAccessor(settings: GameSettingsAccessor): GameSettings {
		return this.normalize(settings.toGameSettings());
	}

	public resolve(settings: GameSettingsAccessor | Partial<GameSettings>): GameSettings {
		return isGameSettingsAccessor(settings)
			? this.fromAccessor(settings)
			: this.normalize(settings);
	}

	public metadata(scope: GameSettingsScope): GameSettingsMetadata {
		return {
			definitions: this.settings
				.filter((setting) => setting.appliesTo(scope))
				.map((setting) => setting.metadata()),
		};
	}

	private fromEntries(read: (setting: GameSetting<unknown>) => unknown): GameSettings {
		return Object.fromEntries(
			this.settings.map((setting) => [setting.key, read(setting)]),
		) as unknown as GameSettings;
	}
}

export class PublicGameSettings implements GameSettingsAccessor {
	private pendingSettings: GameSettings;

	public constructor(settings: GameSettingsAccessor | Partial<GameSettings> = gameSettingsRegistry.defaults()) {
		this.pendingSettings = gameSettingsRegistry.resolve(settings);
	}

	public get mapSize() {
		return this.pendingSettings.mapSize;
	}

	public get maxPlayers() {
		return this.pendingSettings.maxPlayers;
	}

	public get gameSpeed() {
		return this.pendingSettings.gameSpeed;
	}

	public get zombieSpawnRate() {
		return this.pendingSettings.zombieSpawnRate;
	}

	public get resourceDensity() {
		return { ...this.pendingSettings.resourceDensity };
	}

	public updatePendingSettings(patch: GameSettingsPatch) {
		this.pendingSettings = gameSettingsRegistry.merge(this.pendingSettings, patch);
	}

	public toGameSettings(): GameSettings {
		return {
			...this.pendingSettings,
			resourceDensity: this.resourceDensity,
		};
	}
}

export class PrivateGameSettings implements GameSettingsAccessor {
	private readonly settings: GameSettings;

	public constructor(settings: GameSettingsAccessor | Partial<GameSettings> = gameSettingsRegistry.defaults()) {
		this.settings = gameSettingsRegistry.resolve(settings);
	}

	public get mapSize() {
		return this.settings.mapSize;
	}

	public get maxPlayers() {
		return this.settings.maxPlayers;
	}

	public get gameSpeed() {
		return this.settings.gameSpeed;
	}

	public get zombieSpawnRate() {
		return this.settings.zombieSpawnRate;
	}

	public get resourceDensity() {
		return { ...this.settings.resourceDensity };
	}

	public toGameSettings(): GameSettings {
		return {
			...this.settings,
			resourceDensity: this.resourceDensity,
		};
	}
}

function isGameSettingsAccessor(value: unknown): value is GameSettingsAccessor {
	return !!value && typeof value === "object" && typeof (value as GameSettingsAccessor).toGameSettings === "function";
}

const resourceMap = (value: number) =>
	Object.fromEntries(RESOURCE_TYPES.map((resource) => [resource, value])) as ResourceNumberMap;

export const gameSettingsRegistry = new GameSettingsRegistry([
	new NumberChoiceGameSetting({
		key: "mapSize",
		label: "Map size",
		description: "Controls the overall size of the generated world.",
		category: "World",
		defaultValue: MAP_SIZE,
		options: [
			{ value: 64, label: "Extra Small" },
			{ value: 128, label: "Small" },
			{ value: 256, label: "Normal" },
			{ value: 512, label: "Large" },
			{ value: 1024, label: "Extra Large" },
		],
		env: "GAME_MAP_SIZE",
		scopes: ["publicAdmin", "privateHost"],
		advanced: true,
	}),
	new NumberGameSetting({
		key: "maxPlayers",
		label: "Max players",
		description: "Maximum active kingdoms allowed in a game.",
		category: "Players",
		defaultValue: MAX_PLAYERS,
		min: 1,
		max: 10,
		step: 1,
		env: "GAME_MAX_PLAYERS",
		scopes: ["publicAdmin", "privateHost"],
	}),
	new NumberChoiceGameSetting({
		key: "gameSpeed",
		label: "Game speed",
		description: "How quickly time passes in the world.",
		category: "Pacing",
		defaultValue: 1,
		options: [
			{ value: 0.5, label: "Very Slow" },
			{ value: 0.75, label: "Slow" },
			{ value: 1, label: "Normal" },
			{ value: 1.5, label: "Fast" },
			{ value: 2, label: "Very Fast" },
		],
		env: "GAME_SPEED",
		scopes: ["publicAdmin", "privateHost"],
	}),
	new NumberChoiceGameSetting({
		key: "zombieSpawnRate",
		label: "Zombie spawn rate",
		description: "How frequently zombies spawn in the world.",
		category: "Zombies",
		defaultValue: 1,
		options: [
			{ value: 0, label: "None" },
			{ value: 0.5, label: "Low" },
			{ value: 1, label: "Normal" },
			{ value: 2, label: "High" },
			{ value: 4, label: "Extreme" },
		],
		env: "GAME_ZOMBIE_SPAWN_RATE",
		scopes: ["publicAdmin", "privateHost"],
	}),
	new ResourceNumberGameSetting({
		key: "resourceDensity",
		label: "Resource density",
		description: "Choose how common each resource should be in the world.",
		category: "World",
		defaultValue: resourceMap(1),
		options: [
			{ value: 0, label: "None" },
			{ value: 0.25, label: "Scarce" },
			{ value: 0.5, label: "Sparse" },
			{ value: 1, label: "Normal" },
			{ value: 2, label: "Abundant" },
			{ value: 3, label: "Plentiful" },
		],
		envPrefix: "GAME_RESOURCE_DENSITY",
		scopes: ["publicAdmin", "privateHost"],
	}),
]);
