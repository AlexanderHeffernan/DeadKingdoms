import { TICK_MS } from "../../src/shared/config.js";
import { makeSnapshot } from "../../src/shared/messages.js";
import type { CommandPayload, CommandResult, PlayerId, ResourceType, SnapshotMessage, World } from "../../src/shared/types.js";
import { addPlayer, command, createWorld, emitDevBang, grantPlayerResource, grantPlayerSoldiers, setWorldTimeOfDay, spawnZombieHorde, stepWorld, toggleTownCenterInvincibility } from "../../src/server/world.js";
import { join as joinPublicGame, leave, sendCommand, type SessionCredentials } from "./api.js";

export type GameMode = "public" | "private-host" | "private-client" | "public-spectator";

export type JoinOptions = {
	name: string;
	color: string;
};

export type JoinResult = SessionCredentials & {
	name: string;
	color: string;
	mode: GameMode;
	inviteUrl?: string | undefined;
};

export type SnapshotHandler = (message: SnapshotMessage) => void;
export type NoticeHandler = (message: string) => void;

export interface GameSession {
	readonly mode: GameMode;
	readonly inviteUrl?: string | undefined;
	join(options: JoinOptions): Promise<{ ok: true; result: JoinResult } | { ok: false; error: string }>;
	connect(onSnapshot: SnapshotHandler, onNotice: NoticeHandler): void;
	issue(payload: CommandPayload, sessionToken: string): Promise<CommandResult>;
	leave(credentials: SessionCredentials | null): Promise<void>;
	dispose(): void;
	enableAdminAccess?(secret: string): Promise<PrivateAdminResult>;
	disableAdminMode?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	enableFullMapVision?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	enableSoundDebug?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	enableZombieDebug?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	togglePathDebug?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	togglePathAvailabilityDebug?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	toggleUnitTileDebug?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	spawnZombieHorde?(count: number): PrivateAdminResult | Promise<PrivateAdminResult>;
	grantSoldiers?(count: number): PrivateAdminResult | Promise<PrivateAdminResult>;
	grantResources?(resource: ResourceType, amount: number): PrivateAdminResult | Promise<PrivateAdminResult>;
	toggleTownCenterInvincible?(): PrivateAdminResult | Promise<PrivateAdminResult>;
	emitNoise?(x: number, y: number): PrivateAdminResult | Promise<PrivateAdminResult>;
	setTimeOfDay?(progress: number): PrivateAdminResult | Promise<PrivateAdminResult>;
}

export type PrivateAdminResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export class PublicGameSession implements GameSession {
	readonly mode = "public" as const;
	private eventStream: EventSource | null = null;
	private credentials: SessionCredentials | null = null;
	private adminView = "closed";

	async join(options: JoinOptions) {
		const result = await joinPublicGame(options.name, options.color);
		if (!result.ok || !result.playerId || !result.sessionToken) {
			return { ok: false as const, error: result.error || "Could not join." };
		}
		this.credentials = {
			playerId: result.playerId,
			sessionToken: result.sessionToken,
		};
		return {
			ok: true as const,
			result: {
				...this.credentials,
				name: options.name,
				color: options.color,
				mode: this.mode,
			},
		};
	}

	connect(onSnapshot: SnapshotHandler, onNotice: NoticeHandler) {
		this.eventStream?.close();
		if (!this.credentials) return;
		const { playerId, sessionToken } = this.credentials;
		this.eventStream = new EventSource(`/events?playerId=${encodeURIComponent(playerId)}&sessionToken=${encodeURIComponent(sessionToken)}&adminView=${encodeURIComponent(this.adminView)}`);
		this.eventStream.onmessage = (event) => onSnapshot(JSON.parse(event.data) as SnapshotMessage);
		this.eventStream.onerror = () => onNotice("Connection interrupted.");
	}

	async issue(payload: CommandPayload, sessionToken: string) {
		return sendCommand(payload, sessionToken);
	}

	setAdminView(adminView: string) {
		this.adminView = adminView;
	}

	async leave(credentials: SessionCredentials | null) {
		this.dispose();
		if (credentials) await leave(credentials);
	}

	dispose() {
		this.eventStream?.close();
		this.eventStream = null;
	}
}

export class PrivateHostGameSession implements GameSession {
	readonly mode = "private-host" as const;
	private world: World | null = null;
	private playerId: PlayerId | null = null;
	private sessionToken: string | null = null;
	private tickTimer: number | null = null;
	private snapshotTimer: number | null = null;
	private lastStepAt = 0;
	private stepAccumulatorMs = 0;
	private onSnapshot: SnapshotHandler | null = null;
	private sentExplored = new Set<number>();
	private peers = new Map<string, PrivateConnectionPeer>();
	private room: PrivateRoom | null = null;
	inviteUrl?: string | undefined;

	async join(options: JoinOptions) {
		this.world = createWorld();
		this.playerId = addPlayer(this.world, options.name, options.color);
		this.sessionToken = localSessionToken();
		this.room = await createPrivateRoom();
		this.inviteUrl = inviteUrl(this.room.roomId);
		this.pollOffers();
		return {
			ok: true as const,
			result: {
				playerId: this.playerId,
				sessionToken: this.sessionToken,
				name: options.name,
				color: options.color,
				mode: this.mode,
				inviteUrl: this.inviteUrl,
			},
		};
	}

	connect(onSnapshot: SnapshotHandler) {
		this.onSnapshot = onSnapshot;
		if (this.tickTimer === null) {
			this.lastStepAt = performance.now();
			this.tickTimer = window.setInterval(() => this.step(), Math.max(16, TICK_MS / 2));
		}
		if (this.snapshotTimer === null)
			this.snapshotTimer = window.setInterval(() => this.broadcastSnapshots(), TICK_MS);
		this.broadcastSnapshots();
	}

	async issue(payload: CommandPayload) {
		if (!this.world || payload.playerId !== this.playerId) return { ok: false, error: "Player unavailable." };
		return command(this.world, payload.playerId, payload);
	}

	async leave() {
		this.dispose();
	}

	async enableAdminAccess(secret: string): Promise<PrivateAdminResult> {
		if (!this.world || !this.playerId) return { ok: false, error: "No private world." };
		const result = await validatePrivateAdminSecret(secret);
		if (!result.ok) return result;
		const player = this.world.players[this.playerId];
		if (!player) return { ok: false, error: "Player unavailable." };
		if (player.adminLevel) {
			delete player.adminLevel;
			player.godMode = false;
			player.soundDebug = false;
			player.zombieDebug = false;
			player.pathDebug = false;
			player.pathAvailabilityDebug = false;
			player.unitTileDebug = false;
			return { ok: true, adminLevel: null, enabled: false };
		}
		player.adminLevel = "admin";
		return { ok: true, adminLevel: player.adminLevel, enabled: true };
	}

	disableAdminMode(): PrivateAdminResult {
		const player = this.localAdminPlayer();
		if (!player) return { ok: false, error: "Admin access required." };
		delete player.adminLevel;
		player.godMode = false;
		player.soundDebug = false;
		player.zombieDebug = false;
		player.pathDebug = false;
		player.pathAvailabilityDebug = false;
		player.unitTileDebug = false;
		return { ok: true };
	}

	enableFullMapVision(): PrivateAdminResult {
		const player = this.localAdminPlayer();
		if (!player) return { ok: false, error: "Admin access required." };
		player.godMode = !player.godMode;
		return { ok: true, enabled: player.godMode };
	}

	enableSoundDebug(): PrivateAdminResult {
		const player = this.localAdminPlayer();
		if (!player) return { ok: false, error: "Admin access required." };
		player.soundDebug = !player.soundDebug;
		return { ok: true, enabled: player.soundDebug };
	}

	enableZombieDebug(): PrivateAdminResult {
		const player = this.localAdminPlayer();
		if (!player) return { ok: false, error: "Admin access required." };
		player.zombieDebug = !player.zombieDebug;
		return { ok: true, enabled: player.zombieDebug };
	}

	togglePathDebug(): PrivateAdminResult {
		const player = this.localAdminPlayer();
		if (!player) return { ok: false, error: "Admin access required." };
		player.pathDebug = !player.pathDebug;
		return { ok: true, enabled: player.pathDebug };
	}

	togglePathAvailabilityDebug(): PrivateAdminResult {
		const player = this.localAdminPlayer();
		if (!player) return { ok: false, error: "Admin access required." };
		player.pathAvailabilityDebug = !player.pathAvailabilityDebug;
		return { ok: true, enabled: player.pathAvailabilityDebug };
	}

	toggleUnitTileDebug(): PrivateAdminResult {
		const player = this.localAdminPlayer();
		if (!player) return { ok: false, error: "Admin access required." };
		player.unitTileDebug = !player.unitTileDebug;
		return { ok: true, enabled: player.unitTileDebug };
	}

	spawnZombieHorde(count: number): PrivateAdminResult {
		if (!this.world || !this.localAdminPlayer() || !this.playerId) return { ok: false, error: "Admin access required." };
		return { ok: true, spawned: spawnZombieHorde(this.world, this.playerId, count) };
	}

	grantSoldiers(count: number): PrivateAdminResult {
		if (!this.world || !this.localAdminPlayer() || !this.playerId) return { ok: false, error: "Admin access required." };
		return { ok: true, granted: grantPlayerSoldiers(this.world, this.playerId, count) };
	}

	grantResources(resource: ResourceType, amount: number): PrivateAdminResult {
		if (!this.world || !this.localAdminPlayer() || !this.playerId) return { ok: false, error: "Admin access required." };
		const total = grantPlayerResource(this.world, this.playerId, resource, amount);
		return total === null ? { ok: false, error: "Player unavailable." } : { ok: true, total };
	}

	toggleTownCenterInvincible(): PrivateAdminResult {
		if (!this.world || !this.localAdminPlayer() || !this.playerId) return { ok: false, error: "Admin access required." };
		const invincible = toggleTownCenterInvincibility(this.world, this.playerId);
		return invincible === null ? { ok: false, error: "Town center unavailable." } : { ok: true, invincible };
	}

	emitNoise(x: number, y: number): PrivateAdminResult {
		if (!this.world || !this.localAdminPlayer()) return { ok: false, error: "Admin access required." };
		emitDevBang(this.world, x, y);
		return { ok: true };
	}

	setTimeOfDay(progress: number): PrivateAdminResult {
		if (!this.world || !this.localAdminPlayer()) return { ok: false, error: "Admin access required." };
		setWorldTimeOfDay(this.world, progress);
		return { ok: true };
	}

	private localAdminPlayer() {
		return this.adminPlayer(this.playerId);
	}

	private adminPlayer(playerId: PlayerId | null) {
		if (!this.world || !this.playerId) return null;
		if (!playerId) return null;
		const player = this.world.players[playerId];
		return player?.adminLevel ? player : null;
	}

	dispose() {
		if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
		if (this.snapshotTimer !== null) window.clearInterval(this.snapshotTimer);
		this.tickTimer = null;
		this.snapshotTimer = null;
		this.stepAccumulatorMs = 0;
		for (const peer of this.peers.values()) peer.close();
		this.peers.clear();
		this.room = null;
	}

	private step() {
		if (!this.world) return;
		const now = performance.now();
		this.stepAccumulatorMs = Math.min(TICK_MS * 3, this.stepAccumulatorMs + Math.max(0, now - this.lastStepAt));
		this.lastStepAt = now;
		while (this.stepAccumulatorMs >= TICK_MS) {
			stepWorld(this.world, TICK_MS / 1000);
			this.stepAccumulatorMs -= TICK_MS;
		}
	}

	private broadcastSnapshots() {
		if (!this.world || !this.playerId) return;
		this.onSnapshot?.(makeSnapshot(this.world, this.playerId, this.sentExplored));
		for (const peer of this.peers.values()) peer.sendSnapshot(this.world);
	}

	private pollOffers() {
		if (!this.room) return;
		const poll = async () => {
			if (!this.room || !this.world) return;
			try {
				const offers = await listPrivateOffers(this.room, this.playerCount());
				for (const offer of offers.offers) {
					if (this.peers.has(offer.peerId)) continue;
					const peerPlayerId = addPlayer(this.world, offer.name, offer.color);
					const peer = new PrivatePeer(
						offer.peerId,
						peerPlayerId,
						this.world,
						(payload) => command(this.world!, peerPlayerId, payload),
						(method, args) => this.handlePeerAdmin(peerPlayerId, method, args),
					);
					this.peers.set(offer.peerId, peer);
					const answer = await peer.answer(offer.offer);
					await postPrivateAnswer(this.room, offer.peerId, answer);
				}
			} finally {
				window.setTimeout(poll, 1000);
			}
		};
		void poll();
	}

	private async handlePeerAdmin(playerId: PlayerId, method: string, args: unknown[]): Promise<PrivateAdminResult> {
		if (method === "enableAdminAccess") return this.enableAdminAccessFor(playerId, String(args[0] ?? ""));
		const player = this.adminPlayer(playerId);
		if (!player) return { ok: false, error: "Admin access required." };
		if (method === "disableAdminMode") {
			delete player.adminLevel;
			player.godMode = false;
			player.soundDebug = false;
			player.zombieDebug = false;
			player.pathDebug = false;
			player.pathAvailabilityDebug = false;
			player.unitTileDebug = false;
			return { ok: true };
		}
		if (method === "enableFullMapVision") {
			player.godMode = !player.godMode;
			return { ok: true, enabled: player.godMode };
		}
		if (method === "enableSoundDebug") {
			player.soundDebug = !player.soundDebug;
			return { ok: true, enabled: player.soundDebug };
		}
		if (method === "enableZombieDebug") {
			player.zombieDebug = !player.zombieDebug;
			return { ok: true, enabled: player.zombieDebug };
		}
		if (method === "togglePathDebug") {
			player.pathDebug = !player.pathDebug;
			return { ok: true, enabled: player.pathDebug };
		}
		if (method === "togglePathAvailabilityDebug") {
			player.pathAvailabilityDebug = !player.pathAvailabilityDebug;
			return { ok: true, enabled: player.pathAvailabilityDebug };
		}
		if (method === "toggleUnitTileDebug") {
			player.unitTileDebug = !player.unitTileDebug;
			return { ok: true, enabled: player.unitTileDebug };
		}
		if (!this.world) return { ok: false, error: "No private world." };
		if (method === "spawnZombieHorde") return { ok: true, spawned: spawnZombieHorde(this.world, playerId, Number(args[0] ?? 500)) };
		if (method === "grantSoldiers") return { ok: true, granted: grantPlayerSoldiers(this.world, playerId, Number(args[0] ?? 100)) };
		if (method === "grantResources") {
			const total = grantPlayerResource(this.world, playerId, args[0] as ResourceType, Number(args[1] ?? 1000));
			return total === null ? { ok: false, error: "Player unavailable." } : { ok: true, total };
		}
		if (method === "toggleTownCenterInvincible") {
			const invincible = toggleTownCenterInvincibility(this.world, playerId);
			return invincible === null ? { ok: false, error: "Town center unavailable." } : { ok: true, invincible };
		}
		if (method === "emitNoise") {
			emitDevBang(this.world, Number(args[0] ?? 0), Number(args[1] ?? 0));
			return { ok: true };
		}
		if (method === "setTimeOfDay") {
			setWorldTimeOfDay(this.world, Number(args[0] ?? 0));
			return { ok: true };
		}
		return { ok: false, error: "Private admin action unavailable." };
	}

	private async enableAdminAccessFor(playerId: PlayerId, secret: string): Promise<PrivateAdminResult> {
		if (!this.world) return { ok: false, error: "No private world." };
		const result = await validatePrivateAdminSecret(secret);
		if (!result.ok) return result;
		const player = this.world.players[playerId];
		if (!player) return { ok: false, error: "Player unavailable." };
		if (player.adminLevel) {
			delete player.adminLevel;
			player.godMode = false;
			player.soundDebug = false;
			player.zombieDebug = false;
			player.pathDebug = false;
			player.pathAvailabilityDebug = false;
			player.unitTileDebug = false;
			return { ok: true, adminLevel: null, enabled: false };
		}
		player.adminLevel = "admin";
		return { ok: true, adminLevel: player.adminLevel, enabled: true };
	}

	private playerCount() {
		if (!this.world) return 1;
		return Object.values(this.world.players).filter((player) => !player.defeated).length;
	}
}

export class PrivateClientGameSession implements GameSession {
	readonly mode = "private-client" as const;
	private peerId = localSessionToken();
	private roomId: string;
	private connection: RTCPeerConnection | null = null;
	private channel: RTCDataChannel | null = null;
	private credentials: SessionCredentials | null = null;
	private onSnapshot: SnapshotHandler | null = null;
	private pendingSnapshot: SnapshotMessage | null = null;
	private nextAdminRequestId = 1;
	private adminRequests = new Map<string, (result: PrivateAdminResult) => void>();

	constructor(roomId: string) {
		this.roomId = roomId;
	}

	async join(options: JoinOptions) {
		this.connection = createPeerConnection();
		this.channel = this.connection.createDataChannel("game");
		this.channel.onmessage = (event) => this.handleMessage(event.data);
		const offer = await this.connection.createOffer();
		await this.connection.setLocalDescription(offer);
		await waitForIceGathering(this.connection);
		await postPrivateOffer(this.roomId, {
			peerId: this.peerId,
			name: options.name,
			color: options.color,
			offer: this.connection.localDescription!,
		});
		const answer = await waitForPrivateAnswer(this.roomId, this.peerId);
		await this.connection.setRemoteDescription(answer);
		const credentials = await this.waitForWelcome();
		this.credentials = credentials;
		return {
			ok: true as const,
			result: {
				...credentials,
				name: options.name,
				color: options.color,
				mode: this.mode,
			},
		};
	}

	connect(onSnapshot: SnapshotHandler) {
		this.onSnapshot = onSnapshot;
		if (this.pendingSnapshot) {
			this.deliverSnapshot(this.pendingSnapshot);
			this.pendingSnapshot = null;
		}
	}

	async issue(payload: CommandPayload) {
		if (!this.channel || this.channel.readyState !== "open") return { ok: false, error: "Private host unavailable." };
		this.channel.send(JSON.stringify({ type: "command", payload }));
		return { ok: true as const };
	}

	async leave() {
		this.dispose();
	}

	dispose() {
		this.channel?.close();
		this.connection?.close();
		this.channel = null;
		this.connection = null;
	}

	private waitForWelcome(): Promise<SessionCredentials> {
		return new Promise((resolve) => {
			const handle = (event: MessageEvent<string>) => {
				const message = JSON.parse(event.data) as PrivateWireMessage;
				if (message.type !== "welcome") return;
				this.channel?.removeEventListener("message", handle);
				resolve(message.credentials);
			};
			this.channel?.addEventListener("message", handle);
		});
	}

	private handleMessage(data: string) {
		const message = JSON.parse(data) as PrivateWireMessage;
		if (message.type === "snapshot") {
			if (this.onSnapshot) this.deliverSnapshot(message.message);
			else this.pendingSnapshot = message.message;
			return;
		}
		if (message.type === "adminResult") {
			const resolve = this.adminRequests.get(message.id);
			if (!resolve) return;
			this.adminRequests.delete(message.id);
			resolve(message.result);
		}
	}

	private deliverSnapshot(message: SnapshotMessage) {
		this.onSnapshot?.(message);
		if (message.type === "snapshot" && Array.isArray(message.visibility?.explored)) {
			this.channel?.send(JSON.stringify({ type: "visibilityReady" } satisfies PrivateWireMessage));
		}
	}

	enableAdminAccess(secret: string) {
		return this.requestAdmin("enableAdminAccess", [secret]);
	}

	disableAdminMode() {
		return this.requestAdmin("disableAdminMode", []);
	}

	enableFullMapVision() {
		return this.requestAdmin("enableFullMapVision", []);
	}

	enableSoundDebug() {
		return this.requestAdmin("enableSoundDebug", []);
	}

	enableZombieDebug() {
		return this.requestAdmin("enableZombieDebug", []);
	}

	togglePathDebug() {
		return this.requestAdmin("togglePathDebug", []);
	}

	togglePathAvailabilityDebug() {
		return this.requestAdmin("togglePathAvailabilityDebug", []);
	}

	toggleUnitTileDebug() {
		return this.requestAdmin("toggleUnitTileDebug", []);
	}

	spawnZombieHorde(count: number) {
		return this.requestAdmin("spawnZombieHorde", [count]);
	}

	grantSoldiers(count: number) {
		return this.requestAdmin("grantSoldiers", [count]);
	}

	grantResources(resource: ResourceType, amount: number) {
		return this.requestAdmin("grantResources", [resource, amount]);
	}

	toggleTownCenterInvincible() {
		return this.requestAdmin("toggleTownCenterInvincible", []);
	}

	emitNoise(x: number, y: number) {
		return this.requestAdmin("emitNoise", [x, y]);
	}

	setTimeOfDay(progress: number) {
		return this.requestAdmin("setTimeOfDay", [progress]);
	}

	private requestAdmin(method: string, args: unknown[]): Promise<PrivateAdminResult> {
		if (!this.channel || this.channel.readyState !== "open") return Promise.resolve({ ok: false, error: "Private host unavailable." });
		const id = `a${this.nextAdminRequestId++}`;
		this.channel.send(JSON.stringify({ type: "adminRequest", id, method, args } satisfies PrivateWireMessage));
		return new Promise((resolve) => {
			this.adminRequests.set(id, resolve);
			window.setTimeout(() => {
				if (!this.adminRequests.has(id)) return;
				this.adminRequests.delete(id);
				resolve({ ok: false, error: "Private host did not respond." });
			}, 5000);
		});
	}
}

export class PublicSpectatorGameSession implements GameSession {
	readonly mode = "public-spectator" as const;
	private eventStream: EventSource | null = null;

	constructor(private readonly secret: string) {}

	async join(options: JoinOptions) {
		return {
			ok: true as const,
			result: {
				playerId: "__spectator" as PlayerId,
				sessionToken: this.secret,
				name: options.name,
				color: options.color,
				mode: this.mode,
			},
		};
	}

	connect(onSnapshot: SnapshotHandler, onNotice: NoticeHandler) {
		this.eventStream?.close();
		this.eventStream = new EventSource(`/api/admin/spectate-public?secret=${encodeURIComponent(this.secret)}&adminView=popup`);
		this.eventStream.onmessage = (event) => onSnapshot(JSON.parse(event.data) as SnapshotMessage);
		this.eventStream.onerror = () => onNotice("Spectator connection interrupted.");
	}

	async issue(): Promise<CommandResult> {
		return { ok: false, error: "Spectators cannot issue player commands." };
	}

	async leave() {
		this.dispose();
	}

	dispose() {
		this.eventStream?.close();
		this.eventStream = null;
	}
}

type PrivateWireMessage =
	| { type: "welcome"; credentials: SessionCredentials }
	| { type: "snapshot"; message: SnapshotMessage }
	| { type: "command"; payload: CommandPayload }
	| { type: "visibilityReady" }
	| { type: "adminRequest"; id: string; method: string; args: unknown[] }
	| { type: "adminResult"; id: string; result: PrivateAdminResult };

type PrivateRoom = {
	roomId: string;
	hostToken: string;
};

type PrivateOffer = {
	peerId: string;
	name: string;
	color: string;
	offer: RTCSessionDescriptionInit;
};

type PrivateConnectionPeer = {
	sendSnapshot(world: World): void;
	close(): void;
};

class PrivatePeer {
	private connection = createPeerConnection();
	private channel: RTCDataChannel | null = null;
	private sentExplored: Set<number> | null = null;
	private sessionToken = localSessionToken();

	constructor(
		private readonly peerId: string,
		private readonly playerId: PlayerId,
		private readonly world: World,
		private readonly onCommand: (payload: CommandPayload) => CommandResult,
		private readonly onAdminRequest: (method: string, args: unknown[]) => Promise<PrivateAdminResult>,
	) {
		this.connection.ondatachannel = (event) => {
			this.channel = event.channel;
			this.channel.onopen = () => this.send({
				type: "welcome",
				credentials: { playerId: this.playerId, sessionToken: this.sessionToken },
			});
			this.channel.onmessage = (message) => this.handleMessage(message.data);
		};
	}

	async answer(offer: RTCSessionDescriptionInit) {
		await this.connection.setRemoteDescription(offer);
		const answer = await this.connection.createAnswer();
		await this.connection.setLocalDescription(answer);
		await waitForIceGathering(this.connection);
		return this.connection.localDescription!;
	}

	sendSnapshot(world: World) {
		const message = makeSnapshot(world, this.playerId, this.sentExplored);
		this.send({
			type: "snapshot",
			message,
		});
	}

	close() {
		this.channel?.close();
		this.connection.close();
	}

	private handleMessage(data: string) {
		const message = JSON.parse(data) as PrivateWireMessage;
		if (message.type === "command") this.onCommand(message.payload);
		if (message.type === "visibilityReady" && this.sentExplored === null) {
			this.sentExplored = new Set(worldExploredFor(this.world, this.playerId));
		}
		if (message.type === "adminRequest") {
			void this.onAdminRequest(message.method, message.args).then((result) => {
				this.send({ type: "adminResult", id: message.id, result });
			});
		}
	}

	private send(message: PrivateWireMessage) {
		if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(message));
	}
}

function localSessionToken() {
	return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function worldExploredFor(world: World, playerId: PlayerId) {
	return world.players[playerId]?.explored ?? [];
}

function createPeerConnection() {
	return new RTCPeerConnection({
		iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
	});
}

function waitForIceGathering(connection: RTCPeerConnection) {
	if (connection.iceGatheringState === "complete") return Promise.resolve();
	return new Promise<void>((resolve) => {
		const handleChange = () => {
			if (connection.iceGatheringState !== "complete") return;
			connection.removeEventListener("icegatheringstatechange", handleChange);
			resolve();
		};
		connection.addEventListener("icegatheringstatechange", handleChange);
		window.setTimeout(() => {
			connection.removeEventListener("icegatheringstatechange", handleChange);
			resolve();
		}, 2000);
	});
}

function privateRoomFromUrl() {
	return new URLSearchParams(window.location.search).get("private");
}

export function pendingPrivateRoomId() {
	return privateRoomFromUrl();
}

async function createPrivateRoom(): Promise<PrivateRoom> {
	const res = await fetch("/api/private-rooms", { method: "POST" });
	return res.json();
}

async function validatePrivateAdminSecret(secret: string): Promise<PrivateAdminResult> {
	const response = await fetch("/api/private-admin-access", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ secret }),
	});
	const result = await response.json() as { ok: boolean; error?: string };
	return result.ok ? { ok: true } : { ok: false, error: result.error || "Invalid admin secret." };
}

async function listPrivateOffers(room: PrivateRoom, playerCount: number): Promise<{ offers: PrivateOffer[] }> {
	const res = await fetch(`/api/private-rooms/${encodeURIComponent(room.roomId)}/offers?hostToken=${encodeURIComponent(room.hostToken)}&playerCount=${encodeURIComponent(String(playerCount))}`);
	if (!res.ok) return { offers: [] };
	const body = await res.json() as { offers?: PrivateOffer[] };
	return { offers: body.offers ?? [] };
}

async function postPrivateOffer(roomId: string, offer: PrivateOffer) {
	await fetch(`/api/private-rooms/${encodeURIComponent(roomId)}/offers`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(offer),
	});
}

async function postPrivateAnswer(room: PrivateRoom, peerId: string, answer: RTCSessionDescriptionInit) {
	await fetch(`/api/private-rooms/${encodeURIComponent(room.roomId)}/answers`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostToken: room.hostToken, peerId, answer }),
	});
}

async function waitForPrivateAnswer(roomId: string, peerId: string): Promise<RTCSessionDescriptionInit> {
	for (;;) {
		const res = await fetch(`/api/private-rooms/${encodeURIComponent(roomId)}/answers/${encodeURIComponent(peerId)}`);
		if (res.ok) {
			const body = await res.json() as { answer?: RTCSessionDescriptionInit };
			if (body.answer) return body.answer;
		}
		await new Promise((resolve) => window.setTimeout(resolve, 1000));
	}
}

function inviteUrl(roomId: string) {
	const url = new URL(window.location.href);
	url.search = "";
	url.searchParams.set("private", roomId);
	return url.toString();
}
