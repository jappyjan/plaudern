import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, Chip } from '@heroui/react';
import { Link } from 'react-router-dom';

/**
 * The one row used everywhere the app lists "documents" — inbox items,
 * recordings, mentions, calendar entries. Callers map their own DTO into a
 * normalised shape (leading glyph, title, subtitle, trailing chip) so every
 * list reads the same. Two densities via `variant`:
 *   - `card` — a prominent pressable HeroUI Card (Inbox, Calendar).
 *   - `row`  — a compact `hover:bg-default-100` link row (detail sub-lists).
 */
export interface DocumentRowProps {
  variant?: 'card' | 'row';
  /** Navigation target — renders the row as a react-router Link. */
  to?: string;
  /** Press handler for rows that act instead of navigate (e.g. open a modal). */
  onPress?: () => void;
  /** Long-press support: fires on press-down / release (used by Inbox selection). */
  onPressStart?: () => void;
  onPressEnd?: () => void;
  /** Leading slot: source icon, avatar, colour bar or a selection checkbox. */
  leading?: ReactNode;
  title: ReactNode;
  /** Meta line under the title; may hold wrapped chips. */
  subtitle?: ReactNode;
  /** Trailing slot, typically a status/percentage Chip. */
  trailing?: ReactNode;
  /** Outline ring — the row is selected. */
  selected?: boolean;
  /** Dim the row — disabled/secondary state. */
  dimmed?: boolean;
  isPressable?: boolean;
  /**
   * An action rendered as an absolutely-positioned sibling (e.g. a delete
   * button). Kept outside the pressable card because nesting buttons is
   * invalid HTML. Only honoured by the `card` variant.
   */
  trailingAction?: ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
  className?: string;
}

/** The shared inner layout: leading | (title over subtitle) | trailing. */
function RowContent({
  leading,
  title,
  subtitle,
  trailing,
}: Pick<DocumentRowProps, 'leading' | 'title' | 'subtitle' | 'trailing'>) {
  return (
    <>
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-default-500">
            {subtitle}
          </span>
        )}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </>
  );
}

export function DocumentRow({
  variant = 'card',
  to,
  onPress,
  onPressStart,
  onPressEnd,
  leading,
  title,
  subtitle,
  trailing,
  selected = false,
  dimmed = false,
  isPressable = true,
  trailingAction,
  onContextMenu,
  className = '',
}: DocumentRowProps) {
  if (variant === 'row') {
    const rowClass = `flex items-center gap-3 rounded-medium p-2 text-left hover:bg-default-100 ${
      dimmed ? 'opacity-60' : ''
    } ${className}`;
    const content = (
      <RowContent leading={leading} title={title} subtitle={subtitle} trailing={trailing} />
    );
    if (to) {
      return (
        <Link to={to} className={rowClass} onContextMenu={onContextMenu}>
          {content}
        </Link>
      );
    }
    if (onPress) {
      return (
        <button type="button" onClick={onPress} className={`w-full ${rowClass}`} onContextMenu={onContextMenu}>
          {content}
        </button>
      );
    }
    return (
      <div className={rowClass} onContextMenu={onContextMenu}>
        {content}
      </div>
    );
  }

  // card variant
  const card = (
    <Card
      {...(to ? { as: Link, to } : {})}
      isPressable={isPressable}
      onPress={onPress}
      onPressStart={onPressStart}
      onPressEnd={onPressEnd}
      className={`w-full ${selected ? 'outline outline-2 outline-primary' : ''} ${className}`}
    >
      <CardBody className={`flex flex-row items-center gap-3 py-2.5 ${trailingAction ? 'pr-12' : ''}`}>
        <RowContent leading={leading} title={title} subtitle={subtitle} trailing={trailing} />
      </CardBody>
    </Card>
  );

  // A trailing action can't nest inside the pressable card, so wrap both in a
  // positioned container and lay the action over the card's right edge.
  if (trailingAction || onContextMenu || dimmed) {
    return (
      <div
        className={`relative w-full ${dimmed ? 'opacity-40' : ''}`}
        onContextMenu={onContextMenu}
      >
        {card}
        {trailingAction}
      </div>
    );
  }
  return card;
}

/**
 * The card shell the detail-page sub-lists share: a heading with an optional
 * count chip, an empty-state message, and the rows themselves.
 */
export function DocumentList({
  title,
  count,
  empty,
  children,
}: {
  title: ReactNode;
  count?: number;
  empty?: ReactNode;
  children: ReactNode;
}) {
  const isEmpty = count === 0;
  return (
    <Card>
      <CardHeader className="flex items-center justify-between pb-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {count !== undefined && (
          <Chip size="sm" variant="flat">
            {count}
          </Chip>
        )}
      </CardHeader>
      <CardBody className="gap-2">
        {isEmpty && empty && <p className="text-sm text-default-500">{empty}</p>}
        {children}
      </CardBody>
    </Card>
  );
}
