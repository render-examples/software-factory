/**
 * Shared Redis client — single connection reused by threads, blobs, and
 * any future KV-backed module.
 */
import { createClient, type RedisClientType } from "redis";

let _client: RedisClientType | undefined;

export async function kv(): Promise<RedisClientType> {
  if (_client?.isOpen) return _client;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  _client = createClient({ url }) as RedisClientType;
  await _client.connect();
  return _client;
}
