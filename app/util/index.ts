// Dependency-free: the Sandbox runner bundle and the gateway import this module.

/** A full 40-character lowercase hex Git object ID. */
export const SHA = /^[0-9a-f]{40}$/;

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
