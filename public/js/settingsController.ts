import { CameraDragPan, DEFAULT_DRAG_PAN_SENSITIVITY, MAX_DRAG_PAN_SENSITIVITY, MIN_DRAG_PAN_SENSITIVITY, clampDragPanSensitivity } from "./cameraDragPan.js";
import { CameraEdgeScroll, DEFAULT_EDGE_SCROLL_SPEED, MAX_EDGE_SCROLL_SPEED, MIN_EDGE_SCROLL_SPEED, clampEdgeScrollSpeed } from "./cameraEdgeScroll.js";
import type { CameraPanThrow } from "./cameraPanThrow.js";
import type { MusicPlayer } from "./musicPlayer.js";
import type { SoundEffects } from "./sfx.js";
import type { ActionHotkeySettings } from "./actionHotkeySettings.js";

const TEXT_SCALE_STORAGE_KEY = "rtsTextScale";
const MASTER_VOLUME_STORAGE_KEY = "rtsMasterVolume";
const MUSIC_VOLUME_STORAGE_KEY = "rtsMusicVolume";
const SFX_VOLUME_STORAGE_KEY = "rtsSfxVolume";
const THROW_PANNING_STORAGE_KEY = "rtsThrowPanning";
const DRAG_PAN_SENSITIVITY_STORAGE_KEY = "rtsDragPanSensitivity";
const POINTER_LOCK_PANNING_STORAGE_KEY = "rtsPointerLockPanning";
const EDGE_SCROLL_STORAGE_KEY = "rtsEdgeScroll";
const EDGE_SCROLL_SPEED_STORAGE_KEY = "rtsEdgeScrollSpeed";
const DEFAULT_TEXT_SCALE = 100;
const DEFAULT_VOLUME = 100;
const MIN_TEXT_SCALE = 80;
const MAX_TEXT_SCALE = 150;
const TEXT_SCALE_SLIDER_THUMB_WIDTH = 14;

export class SettingsController {
	constructor(
		private readonly music: MusicPlayer,
		private readonly sfx: SoundEffects,
		private readonly cameraDragPan: CameraDragPan,
		private readonly cameraEdgeScroll: CameraEdgeScroll,
		private readonly cameraPanThrow: CameraPanThrow,
		private readonly restartTutorial: () => void,
		private readonly actionHotkeySettings: ActionHotkeySettings,
	) {}

	init() {
		this.initTextScale();
		this.initVolume();
		this.initThrowPanning();
		this.initDragPanSensitivity();
		this.initPointerLockPanning();
		this.initEdgeScroll();
	}

	wireDom() {
		this.actionHotkeySettings.wireDom();
		document.getElementById("settingsButton")?.addEventListener("click", (event) => this.openModal(event));
		document.getElementById("settingsCloseButton")?.addEventListener("click", () => this.closeModal());
		document.getElementById("settingsMuteButton")?.addEventListener("change", (event) => this.music.toggleMute(event));
		document.getElementById("settingsModal")?.addEventListener("pointerdown", (event) => this.closeModalOnBackdrop(event));
		document.getElementById("masterVolumeInput")?.addEventListener("input", (event) => {
			if (event.target instanceof HTMLInputElement) this.setMasterVolume(Number(event.target.value));
		});
		document.getElementById("musicVolumeInput")?.addEventListener("input", (event) => {
			if (event.target instanceof HTMLInputElement) this.setMusicVolume(Number(event.target.value));
		});
		document.getElementById("sfxVolumeInput")?.addEventListener("input", (event) => {
			if (event.target instanceof HTMLInputElement) this.setSfxVolume(Number(event.target.value));
		});
		document.getElementById("textScaleInput")?.addEventListener("input", (event) => {
			if (event.target instanceof HTMLInputElement) this.setTextScale(Number(event.target.value));
		});
		document.getElementById("throwPanningInput")?.addEventListener("change", (event) => {
			if (event.target instanceof HTMLInputElement) this.setThrowPanning(event.target.checked);
		});
		document.getElementById("dragPanSensitivityInput")?.addEventListener("input", (event) => {
			if (event.target instanceof HTMLInputElement) this.setDragPanSensitivity(Number(event.target.value));
		});
		document.getElementById("pointerLockPanningInput")?.addEventListener("change", (event) => {
			if (event.target instanceof HTMLInputElement) this.setPointerLockPanning(event.target.checked);
		});
		document.getElementById("edgeScrollInput")?.addEventListener("change", (event) => {
			if (event.target instanceof HTMLInputElement) this.setEdgeScroll(event.target.checked);
		});
		document.getElementById("edgeScrollSpeedInput")?.addEventListener("input", (event) => {
			if (event.target instanceof HTMLInputElement) this.setEdgeScrollSpeed(Number(event.target.value));
		});
		document.getElementById("restartTutorialButton")?.addEventListener("click", () => {
			this.restartTutorial();
			this.closeModal();
		});
		document.addEventListener("keydown", (event) => this.closeModalOnEscape(event));
		window.addEventListener("resize", () => this.updateResponsiveControls());
	}

	openModal(event?: Event) {
		event?.stopPropagation();
		const modal = document.getElementById("settingsModal");
		const button = document.getElementById("settingsButton");
		if (!modal || !button) return;
		modal.classList.remove("hidden");
		button.setAttribute("aria-expanded", "true");
		this.initVolume();
		this.updateTextScaleControl(this.storedTextScale());
		this.updateDragPanSensitivityControl(this.storedDragPanSensitivity());
		this.updateEdgeScrollSpeedControl(this.storedEdgeScrollSpeed());
	}

	closeModal() {
		const modal = document.getElementById("settingsModal");
		const button = document.getElementById("settingsButton");
		if (!modal || !button) return;
		modal.classList.add("hidden");
		button.setAttribute("aria-expanded", "false");
	}

	private closeModalOnBackdrop(event: PointerEvent) {
		const modal = document.getElementById("settingsModal");
		if (!modal || modal.classList.contains("hidden")) return;
		if (event.target === modal) this.closeModal();
	}

	private closeModalOnEscape(event: KeyboardEvent) {
		const modal = document.getElementById("settingsModal");
		if (event.key !== "Escape" || !modal || modal.classList.contains("hidden")) return;
		this.closeModal();
	}

	private updateResponsiveControls() {
		this.updateTextScaleControl(this.storedTextScale());
		this.updateDragPanSensitivityControl(this.storedDragPanSensitivity());
		this.updateEdgeScrollSpeedControl(this.storedEdgeScrollSpeed());
	}

	private initTextScale() {
		this.setTextScale(this.storedTextScale());
	}

	private storedTextScale() {
		return this.clampTextScale(Number(localStorage.getItem(TEXT_SCALE_STORAGE_KEY)) || DEFAULT_TEXT_SCALE);
	}

	private setTextScale(value: number) {
		const scale = this.clampTextScale(value);
		document.documentElement.style.setProperty("--ui-text-scale", String(scale / 100));
		localStorage.setItem(TEXT_SCALE_STORAGE_KEY, String(scale));
		this.updateTextScaleControl(scale);
	}

	private updateTextScaleControl(scale: number) {
		const input = document.getElementById("textScaleInput");
		const value = document.getElementById("textScaleValue");
		if (input instanceof HTMLInputElement) {
			input.value = String(scale);
			input.style.setProperty("--range-progress", this.textScaleSliderProgress(input, scale));
		}
		if (value) value.textContent = `${scale}%`;
	}

	private textScaleSliderProgress(input: HTMLInputElement, scale: number) {
		const progress = (scale - MIN_TEXT_SCALE) / (MAX_TEXT_SCALE - MIN_TEXT_SCALE);
		const width = input.getBoundingClientRect().width;
		if (width <= 0) return `${progress * 100}%`;
		return `${TEXT_SCALE_SLIDER_THUMB_WIDTH / 2 + progress * (width - TEXT_SCALE_SLIDER_THUMB_WIDTH)}px`;
	}

	private clampTextScale(value: number) {
		if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE;
		return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, Math.round(value)));
	}

	private initVolume() {
		this.applyVolume();
		this.updateVolumeControl("masterVolumeInput", "masterVolumeValue", this.storedMasterVolume());
		this.updateVolumeControl("musicVolumeInput", "musicVolumeValue", this.storedMusicVolume());
		this.updateVolumeControl("sfxVolumeInput", "sfxVolumeValue", this.storedSfxVolume());
	}

	private storedMasterVolume() {
		return this.storedVolume(MASTER_VOLUME_STORAGE_KEY);
	}

	private storedMusicVolume() {
		return this.storedVolume(MUSIC_VOLUME_STORAGE_KEY);
	}

	private storedSfxVolume() {
		return this.storedVolume(SFX_VOLUME_STORAGE_KEY);
	}

	private storedVolume(key: string) {
		const stored = localStorage.getItem(key);
		return stored === null ? DEFAULT_VOLUME : this.clampVolume(Number(stored));
	}

	private setMasterVolume(volume: number) {
		this.setStoredVolume(MASTER_VOLUME_STORAGE_KEY, volume);
	}

	private setMusicVolume(volume: number) {
		this.setStoredVolume(MUSIC_VOLUME_STORAGE_KEY, volume);
	}

	private setSfxVolume(volume: number) {
		this.setStoredVolume(SFX_VOLUME_STORAGE_KEY, volume);
	}

	private setStoredVolume(key: string, volume: number) {
		const clamped = this.clampVolume(volume);
		localStorage.setItem(key, String(clamped));
		this.applyVolume();
		this.updateVolumeControl(this.volumeInputId(key), this.volumeValueId(key), clamped);
	}

	private applyVolume() {
		const master = this.storedMasterVolume() / 100;
		const musicVolume = this.storedMusicVolume() / 100;
		const sfxVolume = this.storedSfxVolume() / 100;
		this.music.setVolume(master, musicVolume);
		this.sfx.setVolume(master, sfxVolume);
	}

	private updateVolumeControl(inputId: string, valueId: string, volume: number) {
		const input = document.getElementById(inputId);
		const value = document.getElementById(valueId);
		if (input instanceof HTMLInputElement) {
			input.value = String(volume);
			input.style.setProperty("--range-progress", `${volume}%`);
		}
		if (value) value.textContent = `${volume}%`;
	}

	private volumeInputId(key: string) {
		if (key === MASTER_VOLUME_STORAGE_KEY) return "masterVolumeInput";
		if (key === MUSIC_VOLUME_STORAGE_KEY) return "musicVolumeInput";
		return "sfxVolumeInput";
	}

	private volumeValueId(key: string) {
		if (key === MASTER_VOLUME_STORAGE_KEY) return "masterVolumeValue";
		if (key === MUSIC_VOLUME_STORAGE_KEY) return "musicVolumeValue";
		return "sfxVolumeValue";
	}

	private clampVolume(value: number) {
		if (!Number.isFinite(value)) return DEFAULT_VOLUME;
		return Math.min(100, Math.max(0, Math.round(value)));
	}

	private initThrowPanning() {
		this.setThrowPanning(this.storedThrowPanning());
	}

	private storedThrowPanning() {
		return localStorage.getItem(THROW_PANNING_STORAGE_KEY) === "true";
	}

	private setThrowPanning(enabled: boolean) {
		localStorage.setItem(THROW_PANNING_STORAGE_KEY, String(enabled));
		this.cameraPanThrow.setEnabled(enabled);
		this.updateThrowPanningControl(enabled);
	}

	private updateThrowPanningControl(enabled: boolean) {
		const input = document.getElementById("throwPanningInput");
		if (input instanceof HTMLInputElement) input.checked = enabled;
	}

	private initDragPanSensitivity() {
		this.setDragPanSensitivity(this.storedDragPanSensitivity());
	}

	private storedDragPanSensitivity() {
		return clampDragPanSensitivity(Number(localStorage.getItem(DRAG_PAN_SENSITIVITY_STORAGE_KEY)) || DEFAULT_DRAG_PAN_SENSITIVITY);
	}

	private setDragPanSensitivity(sensitivity: number) {
		const clamped = clampDragPanSensitivity(sensitivity);
		localStorage.setItem(DRAG_PAN_SENSITIVITY_STORAGE_KEY, String(clamped));
		this.cameraDragPan.setSensitivity(clamped);
		this.updateDragPanSensitivityControl(clamped);
	}

	private updateDragPanSensitivityControl(sensitivity: number) {
		const input = document.getElementById("dragPanSensitivityInput");
		const value = document.getElementById("dragPanSensitivityValue");
		if (input instanceof HTMLInputElement) {
			input.value = String(sensitivity);
			input.style.setProperty("--range-progress", `${((sensitivity - MIN_DRAG_PAN_SENSITIVITY) / (MAX_DRAG_PAN_SENSITIVITY - MIN_DRAG_PAN_SENSITIVITY)) * 100}%`);
		}
		if (value) value.textContent = `${sensitivity.toFixed(1)}x`;
	}

	private initPointerLockPanning() {
		this.setPointerLockPanning(this.storedPointerLockPanning());
	}

	private storedPointerLockPanning() {
		return localStorage.getItem(POINTER_LOCK_PANNING_STORAGE_KEY) !== "false";
	}

	private setPointerLockPanning(enabled: boolean) {
		localStorage.setItem(POINTER_LOCK_PANNING_STORAGE_KEY, String(enabled));
		this.cameraDragPan.setPointerLockEnabled(enabled);
		this.updatePointerLockPanningControl(enabled);
	}

	private updatePointerLockPanningControl(enabled: boolean) {
		const input = document.getElementById("pointerLockPanningInput");
		if (input instanceof HTMLInputElement) input.checked = enabled;
	}

	private initEdgeScroll() {
		this.setEdgeScroll(this.storedEdgeScroll());
		this.setEdgeScrollSpeed(this.storedEdgeScrollSpeed());
	}

	private storedEdgeScroll() {
		return localStorage.getItem(EDGE_SCROLL_STORAGE_KEY) !== "false";
	}

	private storedEdgeScrollSpeed() {
		return clampEdgeScrollSpeed(Number(localStorage.getItem(EDGE_SCROLL_SPEED_STORAGE_KEY)) || DEFAULT_EDGE_SCROLL_SPEED);
	}

	private setEdgeScroll(enabled: boolean) {
		localStorage.setItem(EDGE_SCROLL_STORAGE_KEY, String(enabled));
		this.cameraEdgeScroll.setEnabled(enabled);
		this.updateEdgeScrollControl(enabled);
	}

	private setEdgeScrollSpeed(speed: number) {
		const clamped = clampEdgeScrollSpeed(speed);
		localStorage.setItem(EDGE_SCROLL_SPEED_STORAGE_KEY, String(clamped));
		this.cameraEdgeScroll.setSpeed(clamped);
		this.updateEdgeScrollSpeedControl(clamped);
	}

	private updateEdgeScrollControl(enabled: boolean) {
		const input = document.getElementById("edgeScrollInput");
		if (input instanceof HTMLInputElement) input.checked = enabled;
	}

	private updateEdgeScrollSpeedControl(speed: number) {
		const input = document.getElementById("edgeScrollSpeedInput");
		const value = document.getElementById("edgeScrollSpeedValue");
		if (input instanceof HTMLInputElement) {
			input.value = String(speed);
			input.style.setProperty("--range-progress", `${((speed - MIN_EDGE_SCROLL_SPEED) / (MAX_EDGE_SCROLL_SPEED - MIN_EDGE_SCROLL_SPEED)) * 100}%`);
		}
		if (value) value.textContent = String(speed);
	}
}
