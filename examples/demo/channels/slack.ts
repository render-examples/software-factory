import { slackChannel } from "@render-agents/sdk";

// Auto-discovered at POST /channels/slack. The built-in Slack reference channel
// wires the conversational `assistant` agent to Slack end-to-end:
//   • inbound  — Events API (app_mention + threaded replies + DMs), verified by
//     the `v0=` signature over the raw body using SLACK_SIGNING_SECRET;
//   • outbound — the assistant's reply is posted back with chat.postMessage
//     (threaded under the originating message) using SLACK_BOT_TOKEN.
//
// A threaded/DM follow-up resolves to the same agent thread, so the conversation
// has multi-turn memory. Because `assistant` gates `deploy` on approval, asking it
// to deploy from Slack pauses the run and delivers the approval prompt back to the
// thread (HITL over a channel); approve/deny via the inputs API/operator UI.
export default slackChannel({ target: { agent: "assistant" } });
