import { Suspense, lazy, memo } from "react";

/**
 * GitHub-flavoured Markdown renderer for agent/assistant content. Styling is
 * scoped under `.md` in styles.css. The heavy react-markdown implementation is
 * code-split (see MarkdownImpl) so it loads on demand — the operator lands on
 * Runs, not chat, so the initial bundle stays lean. While the chunk loads we
 * fall back to the raw text (which is readable and preserves content).
 *
 * Syntax highlighting (Shiki) is intentionally deferred until a heavier
 * code-viewing surface needs it — this keeps chat rendering light.
 */
const MarkdownImpl = lazy(() => import("./MarkdownImpl"));

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <Suspense fallback={<span style={{ whiteSpace: "pre-wrap" }}>{children}</span>}>
        <MarkdownImpl>{children}</MarkdownImpl>
      </Suspense>
    </div>
  );
});
