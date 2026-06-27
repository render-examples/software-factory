import type { Logger } from "@render-agents/store";

export interface WebhookMatch {
  workflow: string;
  trigger: string;
}

export interface ConnectorContext {
  env(name: string): string | undefined;
  readonly logger: Logger;
}

export interface ConnectorSpec {
  readonly key: string;
  readonly name: string;
  handle(req: Request, ctx: ConnectorContext): Promise<WebhookMatch | null>;
}
