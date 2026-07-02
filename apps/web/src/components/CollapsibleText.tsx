import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';

export function CollapsibleText({
  text,
  collapsedLines = 8,
  className,
}: {
  text: string;
  collapsedLines?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  // Overflow is only measurable while the clamp is applied; while expanded,
  // isOverflowing keeps its last collapsed value so the toggle stays visible.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setIsOverflowing(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="flex flex-col gap-2">
      <p
        ref={textRef}
        className={className}
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: collapsedLines,
                overflow: 'hidden',
              }
        }
      >
        {text}
      </p>
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
