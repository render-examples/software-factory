import { requireEnv } from "../config/index.js";
import { createDb, migrate } from "../db/index.js";

const db = createDb(requireEnv("DATABASE_URL"), 3);
const applied = await migrate(db);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

// Importing the module registers every task with the Render Workflows SDK, which starts serving them right after,
// so it must follow the migration.
await import("../workflows/index.js");

console.log("software-factory workflows ready");
