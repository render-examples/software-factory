/** Shared Redis client used for large workflow handoff artifacts. */
import { createClient, type RedisClientType } from "redis";

let _client: RedisClientType | undefined;
let _connectPromise: Promise<RedisClientType> | undefined;

export async function kv(): Promise<RedisClientType> {
  if (_client?.isOpen) return _client;
  if (_connectPromise) return _connectPromise;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");

  _client?.destroy();
  const client = createClient({ url }) as RedisClientType;
  client.on("error", (error) => {
    console.error("Key Value client error:", error);
  });
  _client = client;
  _connectPromise = client
    .connect()
    .then(() => client)
    .catch((error) => {
      if (_client === client) _client = undefined;
      client.destroy();
      throw error;
    })
    .finally(() => {
      _connectPromise = undefined;
    });
  return _connectPromise;
}

export async function closeKv(): Promise<void> {
  const pending = _connectPromise;
  if (pending) {
    await pending.catch(() => undefined);
  }
  const client = _client;
  _client = undefined;
  _connectPromise = undefined;
  if (!client) return;
  if (client.isOpen) {
    await client.close();
  } else {
    client.destroy();
  }
}
