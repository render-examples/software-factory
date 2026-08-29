import { defineFactory } from "@render-factory/sdk";
import { assistant } from "./agents/index.js";
import specToPr from "./workflows/spec-to-pr/index.js";
import prReview from "./workflows/pr-review/index.js";
import prFix from "./workflows/pr-fix/index.js";
import github from "./channels/github.js";
import slack from "./channels/slack.js";

export default defineFactory({
  config: {
    repos: ["jacobprall/factory-test-repo"],
  },
  workflows: [specToPr, prReview, prFix],
  channels: [github, slack],
  interactive: [assistant],
});
