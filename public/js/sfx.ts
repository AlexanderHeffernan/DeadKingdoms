import { isoToScreen } from "./iso.js";
import type { Building, ResourceNode, Unit, Vec2 } from "../../src/shared/types.js";
import type { CameraState, ClientSnapshot } from "./clientTypes.js";

export type SoundEffectName =
| "ui_select_unit"
| "ui_select_building"
| "ui_command_move"
| "ui_command_gather"
| "ui_command_attack"
| "ui_command_build"
| "ui_error"
| "work_chop_wood"
| "work_mine_ore"
| "work_gather_food"
| "resource_deposit"
| "farm_replenish"
| "construction_tick"
| "building_complete_small"
| "building_complete_large"
| "building_damaged"
| "building_destroyed"
| "gate_place_or_convert"
| "train_queue"
| "unit_ready_villager"
| "unit_ready_soldier"
| "population_blocked"
| "soldier_attack"
| "zombie_attack"
| "tower_attack"
| "unit_hit"
| "unit_death_human"
| "unit_death_zombie"
| "zombie_idle"
| "under_attack_alert"
| "scout_horn"
| "player_join"
| "player_leave"
| "toast_notice"
| "music_toggle";

type PlayOptions = {
	point?: Vec2 | null;
	volume?: number;
	cooldownKey?: string;
	cooldownMs?: number;
	hearingRadius?: number;
	rate?: number;
};

type Entity = Unit | Building | ResourceNode;
type LoopingSound = {
	source: AudioBufferSourceNode;
	gain: GainNode;
};
type AudioContextWindow = Window & typeof globalThis & {
	webkitAudioContext?: typeof AudioContext;
};

const SOUND_PATH = "/sfx/wav";
const SOUND_ASSET_VERSION = "2026-06-21-5";
const UI_SFX_MASTER_VOLUME = 1.95;
const WORLD_SFX_MASTER_VOLUME = 1.05;
const SCREEN_HEARING_RADIUS = 920;
const UNDER_ATTACK_QUIET_MS = 9000;
const LARGE_BUILDINGS = new Set(["townCenter", "barracks", "watchTower"]);
type SoundEffectDef = {
	volume: number;
	cooldownMs: number;
	space: "ui" | "world";
	variance?: number;
};
const SOUND_EFFECTS: Record<SoundEffectName, SoundEffectDef> = {
	ui_select_unit: { volume: 0.68, cooldownMs: 80, variance: 0.03, space: "ui" },
	ui_select_building: { volume: 0.64, cooldownMs: 80, variance: 0.02, space: "ui" },
	ui_command_move: { volume: 0.56, cooldownMs: 80, variance: 0.03, space: "ui" },
	ui_command_gather: { volume: 0.58, cooldownMs: 100, variance: 0.03, space: "ui" },
	ui_command_attack: { volume: 0.7, cooldownMs: 90, variance: 0.02, space: "ui" },
	ui_command_build: { volume: 0.64, cooldownMs: 100, variance: 0.02, space: "ui" },
	ui_error: { volume: 0.78, cooldownMs: 180, space: "ui" },
	work_chop_wood: { volume: 0.48, cooldownMs: 480, variance: 0.05, space: "world" },
	work_mine_ore: { volume: 0.45, cooldownMs: 560, variance: 0.04, space: "world" },
	work_gather_food: { volume: 0.32, cooldownMs: 900, variance: 0.04, space: "world" },
	resource_deposit: { volume: 0.4, cooldownMs: 320, variance: 0.03, space: "world" },
	farm_replenish: { volume: 0.36, cooldownMs: 500, variance: 0.02, space: "world" },
	construction_tick: { volume: 0.42, cooldownMs: 460, variance: 0.05, space: "world" },
	building_complete_small: { volume: 0.52, cooldownMs: 260, variance: 0.02, space: "world" },
	building_complete_large: { volume: 0.6, cooldownMs: 300, variance: 0.01, space: "world" },
	building_damaged: { volume: 0.34, cooldownMs: 420, variance: 0.04, space: "world" },
	building_destroyed: { volume: 0.58, cooldownMs: 500, variance: 0.02, space: "world" },
	gate_place_or_convert: { volume: 0.42, cooldownMs: 220, variance: 0.02, space: "world" },
	train_queue: { volume: 0.66, cooldownMs: 180, variance: 0.02, space: "ui" },
	unit_ready_villager: { volume: 0.46, cooldownMs: 220, variance: 0.02, space: "world" },
	unit_ready_soldier: { volume: 0.5, cooldownMs: 220, variance: 0.02, space: "world" },
	population_blocked: { volume: 0.78, cooldownMs: 350, space: "ui" },
	soldier_attack: { volume: 0.38, cooldownMs: 160, variance: 0.06, space: "world" },
	zombie_attack: { volume: 0.4, cooldownMs: 260, variance: 0.05, space: "world" },
	tower_attack: { volume: 0.42, cooldownMs: 300, variance: 0.04, space: "world" },
	unit_hit: { volume: 0.28, cooldownMs: 140, variance: 0.05, space: "world" },
	unit_death_human: { volume: 0.48, cooldownMs: 260, variance: 0.03, space: "world" },
	unit_death_zombie: { volume: 0.42, cooldownMs: 220, variance: 0.04, space: "world" },
	zombie_idle: { volume: 0.32, cooldownMs: 850, variance: 0.015, space: "world" },
	under_attack_alert: { volume: 0.5, cooldownMs: 9000, space: "ui" },
	scout_horn: { volume: 3.78, cooldownMs: 0, space: "world" },
	player_join: { volume: 0.68, cooldownMs: 400, space: "ui" },
	player_leave: { volume: 0.6, cooldownMs: 400, space: "ui" },
	toast_notice: { volume: 0.5, cooldownMs: 220, space: "ui" },
	music_toggle: { volume: 0.56, cooldownMs: 160, space: "ui" },
};

export class SoundEffects {
	private readonly cache = new Map<SoundEffectName, Promise<AudioBuffer>>();
	private readonly lastPlayed = new Map<string, number>();
	private readonly hornLoops = new Map<string, LoopingSound>();
	private activeHornIds = new Set<string>();
	private context: AudioContext | null = null;
	private previousSnapshot: ClientSnapshot | null = null;
	private zombieIdleGain: GainNode | null = null;
	private zombieIdleSource: AudioBufferSourceNode | null = null;
	private zombieIdleDesiredVolume = 0;
	private underAttackActive = false;
	private lastOwnedDamageAt = -Infinity;
	private ready = false;

	constructor(private readonly camera: CameraState) {}

	unlock() {
		this.ready = true;
		const context = this.audioContext();
		if (context.state === "suspended") void context.resume();
		for (const name of Object.keys(SOUND_EFFECTS) as SoundEffectName[]) {
			void this.bufferFor(name).catch((error) => console.warn(`Could not load sound effect ${name}.`, error));
		}
	}

	play(name: SoundEffectName, options: PlayOptions = {}) {
		if (!this.ready) return;
		const def = SOUND_EFFECTS[name];
		const cooldownKey = options.cooldownKey ?? name;
		const cooldownMs = options.cooldownMs ?? def.cooldownMs;
		if (!this.canPlay(cooldownKey, cooldownMs)) return;
		const volume = this.effectiveVolume(name, options);
		if (volume <= 0) return;
		this.lastPlayed.set(cooldownKey, performance.now());
		void this.bufferFor(name)
			.then((buffer) => this.playBuffer(buffer, volume, options.rate ?? this.variedRate(def.variance ?? 0)))
			.catch((error) => {
				console.warn(`Could not play sound effect ${name}.`, error);
				this.lastPlayed.delete(cooldownKey);
			});
	}

	observe(snapshot: ClientSnapshot) {
		if (!this.previousSnapshot) {
			this.previousSnapshot = snapshot;
			this.playHornSounds(snapshot);
			return;
		}
		this.playNoticeSounds(this.previousSnapshot, snapshot);
		this.playUnderAttackAlert(this.previousSnapshot, snapshot);
		this.playUnitSounds(this.previousSnapshot, snapshot);
		this.playBuildingSounds(this.previousSnapshot, snapshot);
		this.playHornSounds(snapshot);
		this.playZombieIdle(snapshot);
		this.previousSnapshot = snapshot;
	}

	reset() {
		this.previousSnapshot = null;
		this.lastPlayed.clear();
		this.underAttackActive = false;
		this.lastOwnedDamageAt = -Infinity;
		this.stopZombieIdle();
		this.stopAllHornLoops();
		this.activeHornIds.clear();
	}

	private playNoticeSounds(previous: ClientSnapshot, snapshot: ClientSnapshot) {
		for (const notice of snapshot.notices) {
			if (previous.notices.some((item) => item.id === notice.id)) continue;
			const text = notice.text.toLowerCase();
			if (text.includes("joined the world")) this.play("player_join");
			else if (text.includes("left the world")) this.play("player_leave");
			else this.play("toast_notice");
		}
	}

	private playUnderAttackAlert(previous: ClientSnapshot, snapshot: ClientSnapshot) {
		const now = performance.now();
		const tookDamage = this.ownedBuildingTookDamage(previous, snapshot) || this.ownedUnitTookDamage(previous, snapshot);
		if (tookDamage) {
			this.lastOwnedDamageAt = now;
			if (!this.underAttackActive) {
				this.underAttackActive = true;
				this.play("under_attack_alert");
			}
			return;
		}
		if (this.underAttackActive && now - this.lastOwnedDamageAt >= UNDER_ATTACK_QUIET_MS) {
			this.underAttackActive = false;
		}
	}

	private ownedUnitTookDamage(previous: ClientSnapshot, snapshot: ClientSnapshot) {
		const playerId = snapshot.playerId;
		if (!playerId) return false;
		return Object.values(snapshot.units).some((unit) => {
			const old = previous.units[unit.id];
			return !!old && unit.ownerId === playerId && unit.hp < old.hp;
		});
	}

	private ownedBuildingTookDamage(previous: ClientSnapshot, snapshot: ClientSnapshot) {
		const playerId = snapshot.playerId;
		if (!playerId) return false;
		return Object.values(snapshot.buildings).some((building) => {
			const old = previous.buildings[building.id];
			return !!old && building.ownerId === playerId && building.hp < old.hp;
		});
	}

	private playUnitSounds(previous: ClientSnapshot, snapshot: ClientSnapshot) {
		for (const unit of Object.values(snapshot.units)) {
			const old = previous.units[unit.id];
			if (!old) {
				this.playUnitReady(unit, snapshot);
				continue;
			}
			if ((unit.attackFlash || 0) > 0) this.playUnitAttack(unit);
			if ((unit.workFlash || 0) > 0) this.playWork(unit, snapshot);
			if (old.carried && !unit.carried) this.play("resource_deposit", { point: unit });
			if (unit.hp < old.hp) this.play("unit_hit", { point: unit, cooldownKey: `unit_hit:${unit.id}` });
		}
		for (const old of Object.values(previous.units)) {
			if (snapshot.units[old.id]) continue;
			this.play(old.type === "zombie" ? "unit_death_zombie" : "unit_death_human", { point: old });
		}
	}

	private playBuildingSounds(previous: ClientSnapshot, snapshot: ClientSnapshot) {
		for (const building of Object.values(snapshot.buildings)) {
			const old = previous.buildings[building.id];
			if (!old) continue;
			if (!old.completed && building.completed) {
				const sound = LARGE_BUILDINGS.has(building.type) ? "building_complete_large" : "building_complete_small";
				this.play(sound, { point: this.centerOf(building) });
			}
			if (building.hp < old.hp) this.play("building_damaged", { point: this.centerOf(building), cooldownKey: `building_damaged:${building.id}` });
			if ((building.attackFlash || 0) > 0) this.play("tower_attack", { point: this.centerOf(building), cooldownKey: `tower_attack:${building.id}` });
			if (this.farmWasReplenished(old, building)) this.play("farm_replenish", { point: this.centerOf(building) });
		}
		for (const old of Object.values(previous.buildings)) {
			if (snapshot.buildings[old.id]) continue;
			this.play("building_destroyed", { point: this.centerOf(old) });
		}
	}

	private playZombieIdle(snapshot: ClientSnapshot) {
		const zombies = Object.values(snapshot.units).filter((unit) => unit.type === "zombie");
		if (zombies.length === 0) {
			this.stopZombieIdle();
			return;
		}
		const focus = this.closestEntityToViewport(zombies);
		const groupBoost = Math.min(1.9, 0.7 + Math.sqrt(zombies.length) * 0.08);
		this.updateZombieIdleLoop(this.effectiveVolume("zombie_idle", {
			point: focus,
			volume: groupBoost,
		}));
	}

	private playHornSounds(snapshot: ClientSnapshot) {
		const activeIds = new Set(snapshot.hornSounds.map((sound) => sound.id));
		this.activeHornIds = activeIds;
		for (const id of this.hornLoops.keys()) {
			if (!activeIds.has(id)) this.stopHornLoop(id);
		}
		for (const sound of snapshot.hornSounds) {
			const volume = this.effectiveVolume("scout_horn", {
				point: sound,
				hearingRadius: this.actionHearingRadius(sound.sound),
			});
			if (volume <= 0) this.stopHornLoop(sound.id);
			else this.updateHornLoop(sound.id, volume);
		}
	}

	private playUnitReady(unit: Unit, snapshot: ClientSnapshot) {
		if (unit.ownerId !== snapshot.playerId) return;
		if (unit.type === "villager") this.play("unit_ready_villager", { point: unit });
		else if (unit.type === "soldier") this.play("unit_ready_soldier", { point: unit });
	}

	private playUnitAttack(unit: Unit) {
		const sound = unit.type === "zombie" ? "zombie_attack" : "soldier_attack";
		this.play(sound, { point: unit, cooldownKey: `${sound}:${unit.id}` });
	}

	private playWork(unit: Unit, snapshot: ClientSnapshot) {
		const command = unit.command;
		if (command.type === "build") {
			this.play("construction_tick", { point: unit, cooldownKey: `construction:${command.targetId}` });
			return;
		}
		if (command.type !== "gather") return;
		const target = snapshot.resources[command.targetId] || snapshot.buildings[command.targetId];
		if (!target) return;
		if (target.kind === "resource" && target.resource === "wood") this.play("work_chop_wood", { point: target, cooldownKey: `work:${target.id}` });
		else if (target.kind === "resource" && target.resource === "ore") this.play("work_mine_ore", { point: target, cooldownKey: `work:${target.id}` });
		else this.play("work_gather_food", { point: target, cooldownKey: `work:${target.id}` });
	}

	private farmWasReplenished(previous: Building, building: Building) {
		return building.type === "farm" && (previous.amount ?? 0) <= 0 && (building.amount ?? 0) > 0;
	}

	private effectiveVolume(name: SoundEffectName, options: PlayOptions) {
		const def = SOUND_EFFECTS[name];
		const master = def.space === "ui" ? UI_SFX_MASTER_VOLUME : WORLD_SFX_MASTER_VOLUME;
		const base = def.volume * (options.volume ?? 1) * master;
		const position = def.space === "world" && options.point ? this.positionVolume(options.point, options.hearingRadius, name) : 1;
		const maxVolume = name === "scout_horn" ? 2 : 1;
		return clamp(base * position, 0, maxVolume);
	}

	private positionVolume(point: Vec2, hearingRadius = SCREEN_HEARING_RADIUS, name?: SoundEffectName) {
		const screen = isoToScreen(point.x, point.y, this.camera);
		const cx = window.innerWidth / 2;
		const cy = window.innerHeight / 2;
		const distance = Math.hypot(screen.x - cx, screen.y - cy);
		const zoom = clamp(this.camera.zoom ?? 1, 0.2, 2);
		const zoomRange = (zoom - 0.2) / 1.8;
		const zoomVolume = 0.025 + 1.28 * Math.pow(zoomRange, 1.25);
		const falloff = clamp(1 - distance / hearingRadius, 0, 1);
		if (falloff <= 0) return 0;
		if (name === "scout_horn") return (0.18 + 0.82 * Math.pow(falloff, 0.6)) * zoomVolume;
		return falloff * falloff * zoomVolume;
	}

	private actionHearingRadius(sound: number) {
		return SCREEN_HEARING_RADIUS + Math.sqrt(Math.max(0, sound)) * 55;
	}

	private audioContext() {
		if (this.context) return this.context;
		const audioWindow = window as AudioContextWindow;
		const AudioContextClass = audioWindow.AudioContext || audioWindow.webkitAudioContext;
		if (!AudioContextClass) throw new Error("Web Audio is not supported in this browser.");
		this.context = new AudioContextClass();
		return this.context;
	}

	private bufferFor(name: SoundEffectName) {
		const cached = this.cache.get(name);
		if (cached) return cached;
		const promise = fetch(`${SOUND_PATH}/${name}.wav?v=${SOUND_ASSET_VERSION}`)
			.then((response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.arrayBuffer();
			})
			.then((data) => this.audioContext().decodeAudioData(data.slice(0)));
		this.cache.set(name, promise);
		return promise;
	}

	private playBuffer(buffer: AudioBuffer, volume: number, rate: number) {
		const context = this.audioContext();
		if (context.state === "suspended") void context.resume();
		const source = context.createBufferSource();
		const gain = context.createGain();
		source.buffer = buffer;
		source.playbackRate.value = rate;
		gain.gain.value = volume;
		source.connect(gain);
		gain.connect(context.destination);
		source.start();
	}

	private updateZombieIdleLoop(volume: number) {
		this.zombieIdleDesiredVolume = volume;
		if (volume <= 0) {
			this.stopZombieIdle();
			return;
		}
		const context = this.audioContext();
		if (this.zombieIdleGain) {
			this.zombieIdleGain.gain.setTargetAtTime(volume, context.currentTime, 0.2);
			return;
		}
		void this.bufferFor("zombie_idle")
			.then((buffer) => {
				if (this.zombieIdleDesiredVolume <= 0 || this.zombieIdleSource) return;
				const source = context.createBufferSource();
				const gain = context.createGain();
				source.buffer = buffer;
				source.loop = true;
				gain.gain.value = 0;
				source.connect(gain);
				gain.connect(context.destination);
				this.zombieIdleSource = source;
				this.zombieIdleGain = gain;
				source.start(0, Math.random() * buffer.duration);
				gain.gain.setTargetAtTime(this.zombieIdleDesiredVolume, context.currentTime, 0.25);
			})
			.catch((error) => console.warn("Could not start zombie idle loop.", error));
	}

	private stopZombieIdle() {
		this.zombieIdleDesiredVolume = 0;
		const source = this.zombieIdleSource;
		const gain = this.zombieIdleGain;
		if (!source || !gain) return;
		const context = this.audioContext();
		gain.gain.setTargetAtTime(0, context.currentTime, 0.18);
		window.setTimeout(() => {
			if (this.zombieIdleSource !== source) return;
			source.stop();
			source.disconnect();
			gain.disconnect();
			this.zombieIdleSource = null;
			this.zombieIdleGain = null;
		}, 650);
	}

	private updateHornLoop(id: string, volume: number) {
		const context = this.audioContext();
		const loop = this.hornLoops.get(id);
		if (loop) {
			loop.gain.gain.value = volume;
			return;
		}
		void this.bufferFor("scout_horn")
			.then((buffer) => {
				if (!this.activeHornIds.has(id) || this.hornLoops.has(id)) return;
				const source = context.createBufferSource();
				const gain = context.createGain();
				source.buffer = buffer;
				source.loop = true;
				source.loopStart = Math.min(0.08, buffer.duration * 0.25);
				source.loopEnd = Math.max(source.loopStart + 0.1, buffer.duration - 0.85);
				gain.gain.value = volume;
				source.connect(gain);
				gain.connect(context.destination);
				this.hornLoops.set(id, { source, gain });
				source.start();
			})
			.catch((error) => console.warn("Could not start scout horn loop.", error));
	}

	private stopHornLoop(id: string) {
		const loop = this.hornLoops.get(id);
		if (!loop) return;
		loop.source.stop();
		loop.source.disconnect();
		loop.gain.disconnect();
		this.hornLoops.delete(id);
	}

	private stopAllHornLoops() {
		for (const id of [...this.hornLoops.keys()]) this.stopHornLoop(id);
	}

	private canPlay(key: string, cooldownMs: number) {
		const now = performance.now();
		const last = this.lastPlayed.get(key) ?? -Infinity;
		return now - last >= cooldownMs;
	}

	private variedRate(amount: number) {
		return clamp(1 + (Math.random() * 2 - 1) * amount, 0.82, 1.18);
	}

	private closestEntityToViewport<T extends Vec2>(entities: T[]) {
		return entities.reduce((best, entity) => {
			const bestDistance = this.screenDistance(best);
			const distance = this.screenDistance(entity);
			return distance < bestDistance ? entity : best;
		}, entities[0]!);
	}

	private screenDistance(point: Vec2) {
		const screen = isoToScreen(point.x, point.y, this.camera);
		return Math.hypot(screen.x - window.innerWidth / 2, screen.y - window.innerHeight / 2);
	}

	private centerOf(entity: { x: number; y: number; size?: number; width?: number; height?: number }) {
		return {
			x: entity.x + ((entity.width ?? entity.size ?? 1) - 1) / 2,
			y: entity.y + ((entity.height ?? entity.size ?? 1) - 1) / 2,
		};
	}
}

export function commandSoundForTarget(target: Entity | null): SoundEffectName {
	if (!target) return "ui_command_move";
	if (target.kind === "resource") return "ui_command_gather";
	if (target.kind === "building" && target.gatherResource) return "ui_command_gather";
	if (target.kind === "building" && target.depotGatherKind()) return "ui_command_gather";
	if (target.ownerId) return "ui_command_attack";
	return "ui_command_move";
}

export function buildingCommandSound(buildingType: string): SoundEffectName {
	return buildingType === "gate" ? "gate_place_or_convert" : "ui_command_build";
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}
