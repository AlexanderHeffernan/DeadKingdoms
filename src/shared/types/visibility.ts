/** Computed fog-of-war tile sets cached during a simulation tick. */
export interface VisibilityCache {
  visible: Set<number>;
  explored: Set<number>;
  tick?: number;
}

/** Visibility data sent to clients, including optional hydrated Set forms used locally. */
export interface VisibilityPayload {
  visible: number[];
  explored?: number[] | null;
  exploredDelta?: number[] | null;
  visibleSet?: Set<number>;
  exploredSet?: Set<number>;
}
