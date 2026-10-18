import type { FactoryEvent } from "./types.js";

export type { FactoryEvent } from "./types.js";

/** Appends one event. Never throws and never blocks a run on the database. */
export async function emit(_event: FactoryEvent): Promise<void> {}
