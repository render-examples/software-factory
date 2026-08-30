/**
 * slack-assistant — Run the assistant agent, then post the reply back to Slack.
 */
import { task } from "@renderinc/sdk/workflows";
import { assistantTask } from "../tasks/index.js";

interface SlackAssistantInput {
  message: string;
  threadId: string;
  slackChannel: string;
  slackThreadTs: string;
}

async function postSlackMessage(
  channel: string,
  text: string,
  threadTs: string,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN not set — cannot post reply");
    return;
  }
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  if (!resp.ok) {
    console.error("Slack postMessage failed:", resp.status, await resp.text());
  }
}

export const slackAssistant = task(
  { name: "slack-assistant" },
  async function slackAssistant(input: SlackAssistantInput) {
    const result = await assistantTask({
      message: input.message,
      threadId: input.threadId,
    });

    await postSlackMessage(
      input.slackChannel,
      result,
      input.slackThreadTs,
    );

    return { replied: true, channel: input.slackChannel };
  },
);
