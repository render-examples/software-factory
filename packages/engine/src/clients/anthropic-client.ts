import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Message, TokenUsage } from "@render-agents/store";
import type { ModelClient, CompleteArgs, CompleteResult, ModelStreamEvent, ToolSchema } from "../model.js";

/**
 * Native Anthropic adapter for the Messages API.
 *
 * - Cache-pins the system prompt so prompt caching activates across turns
 * - Translates internal ContentBlock ↔ Anthropic wire format
 * - Normalizes stop_reason to the engine's vocabulary
 */
export class AnthropicClient implements ModelClient {
  private client: Anthropic;

  constructor(opts?: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts?.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const response = await this.client.messages.create(this.buildBody(args), { signal: args.signal });
    return toResult(response);
  }

  /**
   * Streaming variant (D13). Yields `text_delta`s as the model generates so the
   * runner can publish token deltas over the transient `DeltaBus`, then returns
   * the fully-assembled `CompleteResult` (identical shape to `complete`) — the
   * durable `message.assistant`/`llm.call` are still emitted once from that.
   */
  async *stream(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult> {
    const streamed = this.client.messages.stream(this.buildBody(args), { signal: args.signal });
    for await (const event of streamed) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text_delta", text: event.delta.text };
      }
    }
    return toResult(await streamed.finalMessage());
  }

  private buildBody(args: CompleteArgs): Anthropic.MessageCreateParamsNonStreaming {
    const { model, system, tools, messages, sampling, responseFormat } = args;

    const apiMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
      .map(toApiMessage);

    const apiTools = tools.map(toApiTool);

    // Anthropic has no native json_schema response_format; steer the model with
    // the schema appended to the system prompt. The engine still validates the
    // returned JSON against the schema.
    const systemText = responseFormat?.type === "json_schema"
      ? `${system}\n\nYou must respond with a single JSON object that strictly conforms to this JSON Schema. Output only the JSON, with no prose or code fences:\n${JSON.stringify(responseFormat.schema)}`
      : system;

    const systemBlock: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: systemText,
        cache_control: { type: "ephemeral" },
      },
    ];

    return {
      model: model.model,
      max_tokens: sampling?.maxOutputTokens ?? 8192,
      system: systemBlock,
      tools: apiTools.length > 0 ? apiTools : undefined,
      messages: apiMessages,
      ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
    };
  }
}

function toResult(response: Anthropic.Message): CompleteResult {
  const content: ContentBlock[] = response.content.map(fromApiBlock);
  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ...(response.usage.cache_read_input_tokens
      ? { cacheReadTokens: response.usage.cache_read_input_tokens }
      : {}),
    ...(response.usage.cache_creation_input_tokens
      ? { cacheWriteTokens: response.usage.cache_creation_input_tokens }
      : {}),
  };
  return { content, usage, stopReason: normalizeStopReason(response.stop_reason) };
}

function normalizeStopReason(reason: string | null): string {
  if (!reason) return "end_turn";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

function toApiMessage(msg: Message): Anthropic.MessageParam {
  if (msg.role === "tool") {
    return {
      role: "user",
      content: msg.content.map(toApiContentBlock),
    };
  }
  return {
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content.map(toApiContentBlock),
  };
}

function toApiContentBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    default:
      return { type: "text", text: `[unsupported block]` };
  }
}

function fromApiBlock(block: Anthropic.ContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    default:
      return { type: "text", text: `[unsupported block: ${block.type}]` };
  }
}

function toApiTool(tool: ToolSchema): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}
