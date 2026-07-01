import OpenAI from "openai";
import type { ContentBlock, Message, TokenUsage } from "@render-agents/store";
import type { ModelClient, CompleteArgs, CompleteResult, ModelStreamEvent, ToolSchema } from "../model.js";

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
    const response = await this.client.chat.completions.create(this.buildBody(args), { signal: args.signal });

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
      content.push(toToolUseBlock(tc.id, tc.function.name, tc.function.arguments));
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

  /**
   * Streaming variant (D13). Yields assistant `text_delta`s as they arrive, then
   * returns the fully-assembled `CompleteResult` (text + tool_use blocks + usage)
   * — reconstructed from the streamed chunks so it is identical to `complete`.
   * Requires `stream_options.include_usage` for token counts.
   */
  async *stream(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult> {
    const streamed = await this.client.chat.completions.create(
      { ...this.buildBody(args), stream: true, stream_options: { include_usage: true } },
      { signal: args.signal },
    );

    let text = "";
    const toolCalls: Array<{ id?: string; name?: string; args: string }> = [];
    let finishReason: string | null = null;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of streamed) {
      const choice = chunk.choices[0];
      if (choice) {
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = (toolCalls[tc.index] ??= { args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    toolCalls.forEach((tc, i) => {
      if (tc) content.push(toToolUseBlock(tc.id ?? `call_${i}`, tc.name ?? "", tc.args));
    });

    return { content, usage, stopReason: normalizeStopReason(finishReason) };
  }

  private buildBody(args: CompleteArgs): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    const { model, system, tools, messages, sampling } = args;

    const apiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...messages.flatMap(toApiMessages),
    ];

    const apiTools = tools.map(toApiTool);

    return {
      model: model.model,
      messages: apiMessages,
      ...(apiTools.length > 0 ? { tools: apiTools } : {}),
      ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(sampling?.maxOutputTokens !== undefined ? { max_tokens: sampling.maxOutputTokens } : {}),
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
    };
  }
}

function toToolUseBlock(id: string, name: string, args: string | undefined): ContentBlock {
  let parsedInput: unknown = {};
  try {
    parsedInput = args ? JSON.parse(args) : {};
  } catch {
    parsedInput = { _raw: args };
  }
  return { type: "tool_use", id, name, input: parsedInput };
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
