import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Agent text is Markdown. Raw HTML in it is not rendered (react-markdown's default).
// Images are not loaded either: an agent that read hostile text could put data into an image URL,
// and loading it would send that data out. They show as a link you can choose to open.
export function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-dot", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          img: ({ src, alt }) => (
            <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer">
              [image: {alt || "untitled"}]
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
