import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';

/**
 * Collapses arbitrary content to a fixed height with a "Show more"/"Show less"
 * toggle, mirroring CollapsibleText's overflow-driven behaviour for content
 * that isn't plain text (e.g. the segmented speaker transcript).
 */
export function CollapsibleContent({
  children,
  collapsedHeight = 320,
  className,
}: {
  children: ReactNode;
  collapsedHeight?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Overflow is only measurable while the clamp is applied; while expanded,
  // isOverflowing keeps its last collapsed value so the toggle stays visible.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || expanded) return;
    const measure = () => setIsOverflowing(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, children]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={contentRef}
        className={className}
        style={expanded ? undefined : { maxHeight: collapsedHeight, overflow: 'hidden' }}
      >
        {children}
      </div>
      {(isOverflowing || expanded) && (
        <Button
          size="sm"
          variant="light"
          className="self-start"
          onPress={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}
