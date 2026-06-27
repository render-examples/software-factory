import type { ContentBlock } from "./events.js";

export type MessageRole = "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: ContentBlock[];
}
