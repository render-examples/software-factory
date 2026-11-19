export const SHA = /^[0-9a-f]{40}$/;

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
