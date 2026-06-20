export type DayNightPhase = "dawn" | "day" | "dusk" | "night";

export interface DayNightState {
	phase: DayNightPhase;
	cycleProgress: number;
	dayProgress: number;
	visionMultiplier: number;
	light: number;
	label: string;
}

const CYCLE_SECONDS = 12 * 60;
export const DAY_NIGHT_CYCLE_SECONDS = CYCLE_SECONDS;
const DAWN_START = 0.18;
const DAY_START = 0.28;
const DUSK_START = 0.68;
const NIGHT_START = 0.78;
const MIN_NIGHT_VISION = 0.55;

export function dayNightStateAt(elapsedSeconds: number): DayNightState {
	const cycleProgress = positiveModulo(elapsedSeconds / CYCLE_SECONDS, 1);
	const light = daylightAt(cycleProgress);
	const phase = phaseAt(cycleProgress);
	return {
		phase,
		cycleProgress,
		dayProgress: cycleProgress,
		visionMultiplier: MIN_NIGHT_VISION + (1 - MIN_NIGHT_VISION) * light,
		light,
		label: labelFor(cycleProgress, phase),
	};
}

function daylightAt(progress: number) {
	const angle = (progress - 0.25) * Math.PI * 2;
	return Math.max(0, Math.min(1, 0.5 + Math.sin(angle) * 0.5));
}

function phaseAt(progress: number): DayNightPhase {
	if (progress < DAWN_START) return "night";
	if (progress < DAY_START) return "dawn";
	if (progress < DUSK_START) return "day";
	if (progress < NIGHT_START) return "dusk";
	return "night";
}

function labelFor(progress: number, phase: DayNightPhase) {
	const totalMinutes = Math.floor(progress * 24 * 60);
	const hour = Math.floor(totalMinutes / 60);
	const minute = totalMinutes % 60;
	const clock = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
	return `${titleCase(phase)} ${clock}`;
}

function positiveModulo(value: number, modulus: number) {
	return ((value % modulus) + modulus) % modulus;
}

function titleCase(value: string) {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
