import type { Vec2, World } from "../shared/types.js";

export type SpawnContext = {
	world: World;
};

export type SpawnPolicy<TContext extends SpawnContext = SpawnContext> = {
	key: string;
	initialDelaySeconds: number;
	nextDelaySeconds(context: TContext): number;
	canSpawn(context: TContext): boolean;
	currentCount(context: TContext): number;
	cap(context: TContext): number;
	batchSize(context: TContext, remainingCapacity: number): number;
	chooseSpawnPoint(context: TContext): Vec2 | null;
	spawn(context: TContext, point: Vec2): void;
};

export function stepSpawner<TContext extends SpawnContext>(context: TContext, policy: SpawnPolicy<TContext>, dt: number) {
	if (!policy.canSpawn(context)) return;
	const count = policy.currentCount(context);
	const cap = policy.cap(context);
	if (count >= cap) return;
	const timers = context.world.spawnTimers;
	timers[policy.key] = (timers[policy.key] ?? policy.initialDelaySeconds) - dt;
	if (timers[policy.key]! > 0) return;
	timers[policy.key] = policy.nextDelaySeconds(context);
	const batch = policy.batchSize(context, cap - count);
	for (let i = 0; i < batch; i += 1) {
		const spawnPoint = policy.chooseSpawnPoint(context);
		if (spawnPoint) policy.spawn(context, spawnPoint);
	}
}
