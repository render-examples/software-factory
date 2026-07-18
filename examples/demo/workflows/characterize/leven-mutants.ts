import type { Mutant } from "../../src/lib/oracle.js";

/** Curated leven behavioral mutants — verified against sindresorhus/leven index.js. */
export const levenMutants: Mutant[] = [
  { id: "identity-return-1", file: "index.js", find: "return 0;", replace: "return 1;" },
  {
    id: "final-result-off-by-one",
    file: "index.js",
    find: "? maxDistance : result;",
    replace: "? maxDistance : result + 1;",
  },
  {
    id: "dp-branch-a-off-by-one",
    file: "index.js",
    find: "? result + 1 : temporary2)",
    replace: "? result + 2 : temporary2)",
  },
  {
    id: "dp-branch-b-off-by-one",
    file: "index.js",
    find: "? temporary + 1 : temporary2)",
    replace: "? temporary + 2 : temporary2)",
  },
];
