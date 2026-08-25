#!/usr/bin/env node
import { main } from "./main.js";

void main().catch((err: unknown) => {
  console.error("[control-worker] fatal", err);
  process.exit(1);
});
