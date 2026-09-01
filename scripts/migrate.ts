import { migrateFactoryStore } from "#factory/store";

await migrateFactoryStore();
console.log("factory store migrations applied");
