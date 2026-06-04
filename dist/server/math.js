export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
export function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
export function moveToward(entity, target, maxStep) {
    const dx = target.x - entity.x;
    const dy = target.y - entity.y;
    const len = Math.hypot(dx, dy);
    if (len <= maxStep || len === 0) {
        entity.x = target.x;
        entity.y = target.y;
        return true;
    }
    entity.x += (dx / len) * maxStep;
    entity.y += (dy / len) * maxStep;
    return false;
}
export function rectsOverlap(a, b) {
    return a.x < b.x + b.size && a.x + a.size > b.x && a.y < b.y + b.size && a.y + a.size > b.y;
}
