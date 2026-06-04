export function isVisible(visibleSet: Set<number>, x: number, y: number, size: number, mapSize: number): boolean {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.ceil(x + size);
  const y1 = Math.ceil(y + size);
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      if (visibleSet.has(yy * mapSize + xx)) return true;
    }
  }
  return false;
}
