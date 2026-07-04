import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Mermaid } from './Mermaid';
import { SpeakerMention } from './SpeakerMention';

/** Minimal hast shapes — enough to walk and rewrite the tree without @types/hast. */
interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

const MENTION_RE = /@\[([^\]\s]+)\]/g;

function splitMentions(value: string): HastNode[] {
  const parts: HastNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(value))) {
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) });
    parts.push({
      type: 'element',
      tagName: 'speakermention',
      properties: { label: match[1] },
      children: [],
    });
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
  return parts;
}

/**
 * Rehype plugin: replace `@[LABEL]` tokens in prose with a `<speakermention>`
 * element (mapped to a clickable chip below). Skips code/pre so mermaid sources
 * and inline code keep their literal text.
 */
function rehypeSpeakerMentions() {
  const visit = (node: HastNode): void => {
    const el = node as HastElement;
    if (el.type === 'element' && (el.tagName === 'code' || el.tagName === 'pre')) return;
    if (!('children' in node) || !node.children) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && (child as HastText).value.includes('@[')) {
        next.push(...splitMentions((child as HastText).value));
      } else {
        visit(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: HastNode) => visit(tree);
}

type CodeProps = ComponentPropsWithoutRef<'code'> & { children?: ReactNode };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = any;

/**
 * The component overrides. `speakermention` is a custom element the rehype
 * plugin injects; react-markdown renders it by tag name at runtime but its
 * Components type only knows HTML tags, so the map is cast (which also keeps
 * contextual typing for the HTML-element overrides).
 */
const MARKDOWN_COMPONENTS = {
  speakermention: ({ label }: AnyProps) => <SpeakerMention label={label} />,
  // Let the `code` renderer own block vs inline vs mermaid rendering.
  pre: ({ children }: AnyProps) => <>{children}</>,
  code: ({ className, children, ...props }: CodeProps) => {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1];
    if (lang === 'mermaid') {
      return <Mermaid code={String(children).replace(/\n$/, '')} />;
    }
    if (lang) {
      return (
        <pre className="overflow-x-auto rounded-medium bg-default-100 p-3 text-xs">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }
    return (
      <code className="rounded bg-default-100 px-1 py-0.5 text-[0.85em]" {...props}>
        {children}
      </code>
    );
  },
  h1: ({ children }: AnyProps) => <h1 className="text-lg font-semibold">{children}</h1>,
  h2: ({ children }: AnyProps) => <h2 className="text-base font-semibold">{children}</h2>,
  h3: ({ children }: AnyProps) => <h3 className="text-sm font-semibold">{children}</h3>,
  h4: ({ children }: AnyProps) => (
    <h4 className="text-sm font-semibold text-default-600">{children}</h4>
  ),
  ul: ({ children }: AnyProps) => <ul className="ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }: AnyProps) => <ol className="ml-5 list-decimal space-y-1">{children}</ol>,
  li: ({ children }: AnyProps) => <li className="marker:text-default-400">{children}</li>,
  a: ({ href, children }: AnyProps) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
      {children}
    </a>
  ),
  blockquote: ({ children }: AnyProps) => (
    <blockquote className="border-l-2 border-default-300 pl-3 text-default-600">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-default-200" />,
  table: ({ children }: AnyProps) => (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }: AnyProps) => (
    <th className="border-b border-default-200 px-2 py-1 font-semibold">{children}</th>
  ),
  td: ({ children }: AnyProps) => (
    <td className="border-b border-default-100 px-2 py-1">{children}</td>
  ),
} as unknown as Components;

/**
 * Renders summary Markdown: GitHub-flavored markdown, ```mermaid fenced blocks
 * as diagrams, and `@[LABEL]` mentions as clickable speaker chips. Element
 * styling is applied inline (no typography plugin in this app).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSpeakerMentions]}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
