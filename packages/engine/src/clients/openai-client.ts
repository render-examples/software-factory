import OpenAI from "openai";
import type { ContentBlock, Message, TokenUsage } from "@render-agents/store";
import type { ModelClient, CompleteArgs, CompleteResult, ToolSchema } from "../model.js";

/**
 * OpenAI-compatible adapter for the Chat Completions API.
 *
 * Works with any provider exposing an OpenAI-compatible endpoint:
 * OpenAI, OpenRouter, Groq, DeepSeek, Together, vLLM, Ollama, and
 * anything fronted by LiteLLM Proxy. Set `baseURL` and `apiKeyEnv`
 * on the ModelSpec to route requests.
 */
export class OpenAIClient implements ModelClient {
  private client: OpenAI;

  constructor(opts?: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY ?? "missing",
      ...(opts?.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const { model, system, tools, messages, sampling, signal } = args;

    const apiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...messages.flatMap(toApiMessages),
    ];

    const apiTools = tools.map(toApiTool);

    const response = await this.client.chat.completions.create(
      {
        model: model.model,
        messages: apiMessages,
        ...(apiTools.length > 0 ? { tools: apiTools } : {}),
        ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
        ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
        ...(sampling?.maxOutputTokens !== undefined
          ? { max_tokens: sampling.maxOutputTokens }
          : {}),
        ...(args.responseFormat?.type === "json_schema"
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: {
                  name: "response",
                  schema: args.responseFormat.schema,
                  strict: true,
                },
              },
            }
          : {}),
      },
      { signal },
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI adapter: empty choices array in response");
    }

    const content: ContentBlock[] = [];
    const text = choice.message.content;
    if (text) {
      content.push({ type: "text", text });
    }
    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      let parsedInput: unknown = {};
      try {
        parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsedInput = { _raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }

    const usage: TokenUsage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };

    return {
      content,
      usage,
      stopReason: normalizeStopReason(choice.finish_reason),
    };
  }
}

function normalizeStopReason(reason: string | null): string {
  if (!reason || reason === "stop") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return reason;
}

function toApiMessages(msg: Message): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (msg.role === "user") {
    return [{ role: "user", content: collectText(msg.content) }];
  }
  if (msg.role === "assistant") {
    const text = collectText(msg.content);
    const toolCalls = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map<OpenAI.Chat.ChatCompletionMessageToolCall>((b) => ({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }));
    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      ...(text ? { content: text } : { content: null }),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    return [assistant];
  }
  if (msg.role === "tool") {
    return msg.content
      .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
      .map((b) => ({
        role: "tool" as const,
        tool_call_id: b.toolUseId,
        content: b.content,
      }));
  }
  return [];
}

function collectText(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toApiTool(tool: ToolSchema): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
