# Object Storage for Artifacts

## Motivation

Agents produce and reference large artifacts — file contents, diffs, build logs, generated images, tarballs — that don't belong inline in Postgres. Today these live either:

- Inline in `tool_result.content` (event log rows)
- Transiently in sandbox memory (`SandboxDownload.data`)
- In `ThreadItem.data` as JSON

This breaks down at scale: Postgres rows bloat, context windows fill with already-seen content, and artifacts don't survive sandbox termination.

## Current Hook Point

`RunEventRecord` already declares:

```typescript
/** References to externally stored artifacts (used for payloads exceeding 8KB). */
artifactRefs?: Record<string, string>;
```

No backing implementation exists yet.

---

## Design

### Interface

```typescript
// packages/store/src/blob-store.ts

export interface BlobRef {
  key: string;            // e.g. "runs/{runId}/artifacts/{toolCallId}"
  size: number;
  contentType: string;
  createdAt: string;
}

export interface BlobStore {
  put(
    key: string,
    data: Buffer | Readable,
    opts?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<BlobRef>;

  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;

  /** Presigned URL for direct download (Slack attachments, operator UI). */
  getUrl(key: string, opts?: { expiresInSeconds?: number }): Promise<string>;

  delete(key: string): Promise<void>;

  list(prefix: string): Promise<BlobRef[]>;
}
```

### Implementations (Pluggable)

| Backend | When to use |
|---------|-------------|
| `MemoryBlobStore` | Local dev, tests |
| `S3BlobStore` | Production — covers Render Object Store, Cloudflare R2, AWS S3, MinIO, Tigris, DigitalOcean Spaces |
| `GcsBlobStore` | GCP-native deployments (optional, stretch) |

All S3-compatible stores share one implementation via the `@aws-sdk/client-s3` package.

### Factory

Follows the existing `createStore` / `createJobQueue` / `createDeltaBus` pattern:

```typescript
// packages/store/src/create-blob-store.ts

export interface CreateBlobStoreOptions {
  type?: "memory" | "s3" | "gcs";
  bucket?: string;
  endpoint?: string;       // S3-compatible endpoint
  region?: string;
  prefix?: string;         // key prefix for multi-tenant isolation
}

export function createBlobStore(opts?: CreateBlobStoreOptions): BlobStore {
  const type = opts?.type
    ?? (process.env.BLOB_STORE_BUCKET ? "s3" : "memory");

  switch (type) {
    case "s3":    return new S3BlobStore(opts);
    case "gcs":   return new GcsBlobStore(opts);
    default:      return new MemoryBlobStore();
  }
}
```

---

## Integration Points

### 1. Auto-externalize large tool results

In the tool execution path, intercept results exceeding a threshold (default 8KB):

```typescript
const INLINE_THRESHOLD = 8 * 1024;

async function maybeExternalize(
  result: string,
  ctx: { runId: string; toolCallId: string; blobs: BlobStore },
): Promise<{ content: string; artifactRef?: string }> {
  if (Buffer.byteLength(result) <= INLINE_THRESHOLD) {
    return { content: result };
  }
  const key = `runs/${ctx.runId}/tool-results/${ctx.toolCallId}`;
  await ctx.blobs.put(key, Buffer.from(result), { contentType: "text/plain" });
  const truncated = result.slice(0, 2000)
    + `\n\n[... truncated, full output stored as artifact://${key}]`;
  return { content: truncated, artifactRef: key };
}
```

The `artifactRef` populates `RunEventRecord.artifactRefs` so the event log stays bounded but artifacts are recoverable.

### 2. `read_artifact` tool

Lets the agent pull back a previously-externalized result on demand:

```typescript
{
  name: "read_artifact",
  description: "Retrieve a previously stored artifact by key",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
}
```

### 3. Sandbox download persistence

When a sandbox is about to terminate (or on explicit "save"), persist key files to blob storage so downstream agents or workflows can reference them without a live sandbox.

### 4. Context manager awareness

The context compaction strategy can replace large inlined blobs with a short placeholder + artifact ref, reducing token pressure while keeping the agent able to re-hydrate on demand.

---

## Runtime Wiring

```typescript
export interface RuntimeOptions {
  store: RunStore;
  jobQueue: JobQueue;
  deltaBus: DeltaBus;
  cancelStore: CancelStore;
  blobs: BlobStore;          // ← new
}
```

### Gateway download route

```
GET /artifacts/:key
Authorization: Bearer <api-key>
→ streams blob from store (or 302 redirect to presigned URL)
```

---

## Key Design Decision: Key Structure

**Path-based** (recommended) over content-addressable:

```
runs/{runId}/tool-results/{toolCallId}
runs/{runId}/sandbox-files/{path-hash}
threads/{threadId}/attachments/{itemId}/{filename}
```

Rationale: retention cleanup aligns with existing `cleanup(RetentionOptions)` — delete the prefix when the run/thread expires. Content-addressable deduplication is a premature optimization for agent workloads where most artifacts are unique.

---

## Render Object Store Deployment

```yaml
# render.yaml addition
services:
  - type: object-store
    name: factory-artifacts
    region: oregon

envVarGroups:
  - name: blob-storage
    envVars:
      - key: BLOB_STORE_TYPE
        value: s3
      - key: BLOB_STORE_BUCKET
        fromService:
          type: object-store
          name: factory-artifacts
          property: bucket
      - key: BLOB_STORE_ENDPOINT
        fromService:
          type: object-store
          name: factory-artifacts
          property: endpoint
```

No egress fees on the private network between Workflows host / Gateway and Object Store.

---

## Effort Estimate

| Piece | Lines | Time |
|-------|-------|------|
| `BlobStore` interface + `MemoryBlobStore` | ~80 | 30min |
| `S3BlobStore` (covers Render Object Store, R2, etc.) | ~120 | 1hr |
| `createBlobStore` factory | ~40 | 15min |
| Auto-externalize in tool execution | ~50 | 30min |
| `read_artifact` tool | ~30 | 15min |
| Gateway download route | ~60 | 30min |
| Tests | ~150 | 1hr |

**Total: ~530 lines, ~1 day.**

---

## Open Questions

- Should the threshold be per-agent configurable (some agents produce lots of small outputs, others produce few large ones)?
- Do we want a TTL per blob independent of run retention (e.g. "keep PR diffs for 90 days even after the run is cleaned up")?
- Should `read_artifact` be implicitly available to all agents, or opt-in via the agent's `tools:` list?
