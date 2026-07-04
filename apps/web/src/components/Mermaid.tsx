import { useEffect, useRef, useState } from 'react';

/**
 * Load mermaid on demand. It is large (and pulls per-diagram chunks), so keeping
 * it out of the main bundle means only users who open a summary with a diagram
 * pay for it.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/** Observe the app's light/dark toggle (a `dark` class on <html>). */
function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(el.classList.contains('dark')));
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

let counter = 0;

/**
 * Renders a mermaid diagram from its source. Re-renders on theme change so the
 * diagram matches the surrounding light/dark UI. Falls back to the raw source
 * (as a code block) when the diagram is syntactically invalid, so a bad diagram
 * from the model never blanks the summary.
 */
export function Mermaid({ code }: { code: string }) {
  const isDark = useIsDark();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${(counter += 1)}`);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'strict',
        });
        return mermaid.render(idRef.current, code);
      })
      .then(({ svg: rendered }) => {
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setSvg(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, isDark]);

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-medium bg-default-100 p-3 text-xs text-default-600">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="my-2 flex justify-center overflow-x-auto rounded-medium bg-default-50 p-3 [&_svg]:max-w-full"
      // eslint-disable-next-line react/no-danger -- mermaid output, rendered with securityLevel: 'strict'
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
