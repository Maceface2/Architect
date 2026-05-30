import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Obsidian-style reading mode. Renders trusted canvas content (zone roles,
// component specs) — react-markdown escapes raw HTML by default, so no
// sanitizer is needed. Prose styling is carried by per-element Tailwind
// classes (no typography plugin); code stays monospace, links read in the
// accent purple, and the body uses the system UI font like the rest of the app.
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-6 mb-3 text-[24px] font-semibold leading-tight tracking-[-0.01em] text-fg first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2 text-[19px] font-semibold leading-tight tracking-[-0.01em] text-fg first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-2 text-[16px] font-semibold text-fg first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-1.5 text-[14px] font-semibold uppercase tracking-[0.04em] text-fg-muted first:mt-0">{children}</h4>
  ),
  p: ({ children }) => <p className="my-3 text-[14px] leading-7 text-fg first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline-offset-2 hover:underline">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5 text-fg marker:text-fg-subtle first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5 text-fg marker:text-fg-subtle first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="text-[14px] leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-node-border pl-3 text-fg-muted italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-5 border-node-border" />,
  // Inline + fenced code share one component. Fenced blocks render inside a
  // <pre> (styled below); the `.md-body pre code` rule in index.css strips the
  // inline chip look there, so this single class works for both cases.
  code: ({ children, ...props }) => (
    <code className="rounded bg-node px-1 py-0.5 font-mono text-[0.85em] text-fg" {...props}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md bg-node p-3 text-[13px] leading-6 first:mt-0 last:mb-0">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-node-border bg-node px-2 py-1 text-left font-semibold text-fg">{children}</th>
  ),
  td: ({ children }) => <td className="border border-node-border px-2 py-1 text-fg-muted">{children}</td>,
}

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
