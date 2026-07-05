import { Chip } from '@heroui/react';

/**
 * Low-confidence hedge (JJ-20, VISION §6 anti-hallucination). When a generated
 * artifact's citation coverage is thin, the server marks it `confidence: 'low'`
 * and the UI says "I think — check the sources" instead of presenting the prose
 * as settled memory. A memory prosthesis that confabulates is worse than none.
 *
 * Rendered as a plain HeroUI `Chip` (no Modal/Accordion) so it is safe on the
 * iOS PWA, where framer-motion-backed overlays drop their opens. Shared across
 * every prose surface (chat, journal, topic documents) so the phrasing and look
 * stay identical.
 */
export function ConfidenceNote({
  confidence,
  className,
}: {
  confidence: 'high' | 'low' | null | undefined;
  className?: string;
}) {
  if (confidence !== 'low') return null;
  return (
    <Chip size="sm" variant="flat" color="warning" className={`self-start ${className ?? ''}`}>
      I think — check the sources
    </Chip>
  );
}
