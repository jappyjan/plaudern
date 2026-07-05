import { type ReactNode } from 'react';
import { Button, Chip } from '@heroui/react';
import { isMaskedTier, type ItemSensitivityDto, type SensitivityTier } from '@plaudern/contracts';

const TIER_LABEL: Record<SensitivityTier, string> = {
  public: 'Public',
  normal: 'Normal',
  sensitive: 'Sensitive',
  secret: 'Secret',
};

const TIER_COLOR: Record<SensitivityTier, 'default' | 'warning' | 'danger' | 'success'> = {
  public: 'success',
  normal: 'default',
  sensitive: 'warning',
  secret: 'danger',
};

const CATEGORY_LABEL: Record<string, string> = {
  iban: 'bank account (IBAN)',
  credit_card: 'card number',
  credential: 'password / credential',
  national_id: 'national ID',
  health: 'health details',
  other_secret: "someone else's secret",
};

/** A small colored chip for a sensitivity tier. */
export function SensitivityBadge({ tier }: { tier: SensitivityTier }): ReactNode {
  if (tier === 'normal') return null;
  return (
    <Chip size="sm" color={TIER_COLOR[tier]} variant="flat">
      {tier === 'secret' || tier === 'sensitive' ? '🔒 ' : ''}
      {TIER_LABEL[tier]}
    </Chip>
  );
}

/**
 * The item's sensitivity banner (JJ-21): shows the effective tier, why it was
 * flagged, the "held: needs local model" state, and lets the user override the
 * tier. Plain HeroUI Chip/Button + divs only (no Modal) so it stays iOS-PWA
 * safe. Hidden entirely for plain `normal` items with no override.
 */
export function SensitivityBanner({
  sensitivity,
  onOverride,
  saving,
}: {
  sensitivity: ItemSensitivityDto;
  onOverride: (tier: SensitivityTier | null) => void;
  saving: boolean;
}): ReactNode {
  const tier = sensitivity.effectiveTier;
  const interesting =
    tier !== 'normal' || sensitivity.manualTier !== null || sensitivity.held;
  if (!interesting) return null;

  const categories = sensitivity.detections.map((d) => CATEGORY_LABEL[d.category] ?? d.category);

  return (
    <div className="flex flex-col gap-2 rounded-medium border border-default-200 bg-default-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SensitivityBadge tier={tier} />
        {sensitivity.manualTier !== null && (
          <span className="text-xs text-default-500">(set by you)</span>
        )}
        {sensitivity.llmClassified && (
          <span className="text-xs text-default-400">· AI-reviewed</span>
        )}
      </div>

      {categories.length > 0 && (
        <p className="text-xs text-default-500">Detected: {categories.join(', ')}.</p>
      )}

      {isMaskedTier(tier) && (
        <p className="text-xs text-default-500">
          Kept off external AI providers — processed on a local model only. Content is masked below
          until you reveal it.
        </p>
      )}

      {sensitivity.held && (
        <p className="text-xs text-warning-600">
          Held: this item needs a local model tier to be processed. No sensitive content has been
          sent to an external provider. Configure a local model (LOCAL_LLM_ENABLED) to process it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-default-500">Override:</span>
        {(['normal', 'sensitive', 'secret'] as SensitivityTier[]).map((t) => (
          <Button
            key={t}
            size="sm"
            variant={sensitivity.manualTier === t ? 'solid' : 'flat'}
            color={TIER_COLOR[t]}
            isDisabled={saving}
            onPress={() => onOverride(t)}
          >
            {TIER_LABEL[t]}
          </Button>
        ))}
        {sensitivity.manualTier !== null && (
          <Button size="sm" variant="light" isDisabled={saving} onPress={() => onOverride(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Reveal gate (JJ-21): masks its children behind a blur + a plain-div overlay
 * with a "Reveal" button when the tier is sensitive/secret and the user hasn't
 * revealed yet. Uses no HeroUI Modal/Accordion — just positioned divs — so it
 * works inside the iOS PWA. For non-masked tiers it renders children as-is.
 */
export function SensitivityGate({
  tier,
  revealed,
  onReveal,
  children,
}: {
  tier: SensitivityTier;
  revealed: boolean;
  onReveal: () => void;
  children: ReactNode;
}): ReactNode {
  if (!isMaskedTier(tier) || revealed) return <>{children}</>;
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none select-none blur-md"
        style={{ filter: 'blur(8px)' }}
      >
        {children}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-medium bg-default-50/70 p-4 text-center">
        <p className="text-sm font-medium text-default-700">Sensitive content hidden</p>
        <p className="text-xs text-default-500">Masked by default. Tap to reveal.</p>
        <Button size="sm" color="warning" variant="flat" onPress={onReveal}>
          Reveal
        </Button>
      </div>
    </div>
  );
}
