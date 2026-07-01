import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Heavy renderer, loaded on demand (see Markdown.tsx) so react-markdown +
// remark-gfm land in a separate chunk instead of the initial bundle.
export default function MarkdownImpl({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
