export function mustGet(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Missing element ${id}`);
	return el;
}

export function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}

export function label(type: string) {
	return type.replace(/[A-Z]/g, (char) => ` ${char}`).replace(/^./, (char) => char.toUpperCase());
}

export function aliveTime(joinedAt: number, now: number) {
	const totalMinutes = Math.max(0, Math.floor(((now || Date.now()) - (joinedAt || now || Date.now())) / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function timeAgo(now: number, at: number) {
	const seconds = Math.max(0, Math.floor(((now || Date.now()) - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

export function formatClock(at: number) {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
