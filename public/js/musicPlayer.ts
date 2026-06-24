import type { SoundEffects } from "./sfx.js";

const MUSIC_MUTED_STORAGE_KEY = "rtsMusicMuted";
const MUSIC_BASE_VOLUME = 0.25;

export class MusicPlayer {
	private readonly audio = new Audio();
	private tracks: string[] = [];
	private muted = localStorage.getItem(MUSIC_MUTED_STORAGE_KEY) === "true";
	private started = false;
	private masterVolume = 1;
	private musicVolume = 1;

	constructor(private readonly sfx: SoundEffects) {}

	async init() {
		this.audio.muted = this.muted;
		this.audio.loop = false;
		this.audio.preload = "auto";
		this.audio.addEventListener("ended", () => this.playRandomTrack());
		this.updateMuteButton();
		try {
			const res = await fetch("/api/soundtrack");
			const data = await res.json();
			this.tracks = Array.isArray(data.tracks) ? data.tracks : [];
			if (!document.getElementById("game")?.classList.contains("hidden")) this.start();
		} catch {
			this.tracks = [];
		}
	}

	start() {
		if (this.started || this.muted || this.tracks.length === 0) return;
		this.started = true;
		this.playRandomTrack();
	}

	toggleMute(event?: Event) {
		this.sfx.unlock();
		this.sfx.play("music_toggle");
		this.muted = event?.target instanceof HTMLInputElement ? event.target.checked : !this.muted;
		localStorage.setItem(MUSIC_MUTED_STORAGE_KEY, String(this.muted));
		this.audio.muted = this.muted;
		this.applyVolume();
		if (this.muted) {
			this.audio.pause();
			this.started = false;
		} else if (this.audio.src) {
			this.started = true;
			this.audio.play().catch(() => {
				this.started = false;
			});
		} else {
			this.start();
		}
		this.updateMuteButton();
	}

	setVolume(masterVolume: number, musicVolume: number) {
		this.masterVolume = masterVolume;
		this.musicVolume = musicVolume;
		this.applyVolume();
	}

	private playRandomTrack() {
		if (this.muted || this.tracks.length === 0) return;
		const current = this.audio.dataset.track ?? "";
		const currentSong = this.songName(current);
		const differentSongs = this.tracks.filter((track) => this.songName(track) !== currentSong);
		const differentTracks = this.tracks.filter((track) => track !== current);
		const choices = differentSongs.length > 0 ? differentSongs : differentTracks.length > 0 ? differentTracks : this.tracks;
		const track = choices[Math.floor(Math.random() * choices.length)]!;
		this.audio.dataset.track = track;
		this.audio.src = track;
		this.audio.play().catch(() => {
			this.started = false;
		});
	}

	private songName(track: string) {
		if (!track) return "";
		const file = decodeURIComponent(track.split("/").pop() || "");
		return file.replace(/\.mp3$/i, "").replace(/-\d+$/i, "");
	}

	private applyVolume() {
		this.audio.volume = this.muted ? 0 : MUSIC_BASE_VOLUME * this.masterVolume * this.musicVolume;
	}

	private updateMuteButton() {
		const button = document.getElementById("settingsMuteButton");
		if (!button) return;
		if (button instanceof HTMLInputElement) button.checked = this.muted;
		button.setAttribute("aria-label", this.muted ? "Unmute audio" : "Mute audio");
		button.title = this.muted ? "Unmute audio" : "Mute audio";
	}
}
