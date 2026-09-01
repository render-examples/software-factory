import type { FactoryStore } from "./contracts.js";

let configuredStore: FactoryStore | undefined;

export function configureFactoryStore(store: FactoryStore): void {
	configuredStore = store;
}

export function factoryStore(): FactoryStore {
	if (!configuredStore) {
		throw new Error("FactoryStore is not configured");
	}
	return configuredStore;
}

export function clearFactoryStore(): void {
	configuredStore = undefined;
}
