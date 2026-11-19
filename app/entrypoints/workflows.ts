import { migrate, workflowsDb } from "../db/index.js";

const applied = await migrate(workflowsDb());
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

await import("../workflows/index.js");

console.log("software-factory workflows ready");
