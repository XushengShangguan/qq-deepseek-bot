// Whether she's off browsing right now (life.ts sets it, the chat prompt reads
// it), so in chat she doesn't claim to be back with things she hasn't found.
// Kept in its own module: life.ts imports qq.ts, which imports the chat code.

export type Outing = "pending" | "running" | null;

const state = globalThis as unknown as { outing?: Outing };

export function setOuting(o: Outing) {
  state.outing = o;
}

export function currentOuting(): Outing {
  return state.outing ?? null;
}
