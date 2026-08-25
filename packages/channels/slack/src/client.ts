export interface SlackMessageRef {
  channel: string;
  ts: string;
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
  ) {
    super(`Slack ${method} failed: ${slackError}`);
    this.name = "SlackApiError";
  }
}

export interface SlackClient {
  postMessage(args: {
    channel: string;
    text: string;
    blocks?: SlackBlock[];
    threadTs?: string;
    clientMsgId?: string;
  }): Promise<SlackMessageRef>;
  updateMessage(args: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<void>;
  addReaction(args: { channel: string; ts: string; name: string }): Promise<void>;
  removeReaction(args: { channel: string; ts: string; name: string }): Promise<void>;
  authTest(): Promise<{ userId: string; botId: string | null; teamId: string }>;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  user_id?: string;
  bot_id?: string;
  team_id?: string;
}

const BENIGN_ERRORS = new Set(["already_reacted", "no_reaction", "message_not_found"]);
const MAX_ATTEMPTS = 4;

export function createSlackClient(botToken: string, fetchImpl: typeof fetch = fetch): SlackClient {
  async function call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${botToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "1");
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000;
        await sleep(waitMs);
        continue;
      }

      if (response.status >= 500) {
        lastError = new Error(`Slack ${method} returned ${response.status}`);
        await sleep(backoffMs(attempt));
        continue;
      }

      const payload = (await response.json()) as SlackResponse;
      if (!payload.ok && !BENIGN_ERRORS.has(payload.error ?? "")) {
        throw new SlackApiError(method, payload.error ?? `http_${response.status}`);
      }
      return payload;
    }

    throw lastError ?? new Error(`Slack ${method} exhausted retries`);
  }

  return {
    async postMessage({ channel, text, blocks, threadTs, clientMsgId }) {
      const payload = await call("chat.postMessage", {
        channel,
        text,
        blocks,
        thread_ts: threadTs,
        client_msg_id: clientMsgId,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!payload.ts || !payload.channel) {
        throw new SlackApiError("chat.postMessage", "response missing ts or channel");
      }
      return { channel: payload.channel, ts: payload.ts };
    },

    async updateMessage({ channel, ts, text, blocks }) {
      await call("chat.update", { channel, ts, text, blocks });
    },

    async addReaction({ channel, ts, name }) {
      await call("reactions.add", { channel, timestamp: ts, name });
    },

    async removeReaction({ channel, ts, name }) {
      await call("reactions.remove", { channel, timestamp: ts, name });
    },

    async authTest() {
      const payload = await call("auth.test", {});
      if (!payload.user_id) throw new SlackApiError("auth.test", "response missing user_id");
      if (!payload.team_id) throw new SlackApiError("auth.test", "response missing team_id");
      return { userId: payload.user_id, botId: payload.bot_id ?? null, teamId: payload.team_id };
    },
  };
}

function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
