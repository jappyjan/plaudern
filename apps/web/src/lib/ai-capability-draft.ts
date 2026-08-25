import type { AiCapabilitySettingDto } from '@plaudern/contracts';

export interface AiCapabilityDraft {
  providerId: string | null;
  model: string;
  enabled: boolean;
  params: Record<string, unknown>;
  dirty: boolean;
  resetGeneration: number;
}

export function createAiCapabilityDraft(
  setting: AiCapabilitySettingDto,
  resetGeneration: number,
): AiCapabilityDraft {
  return {
    providerId: setting.override.providerId,
    model: setting.override.model ?? '',
    enabled: setting.override.enabled ?? true,
    params: setting.override.params,
    dirty: false,
    resetGeneration,
  };
}

/** Preserve intentional edits on refresh, except when Reset explicitly invalidates them. */
export function reconcileAiCapabilityDraft(
  draft: AiCapabilityDraft,
  setting: AiCapabilitySettingDto,
  resetGeneration: number,
): AiCapabilityDraft {
  if (draft.resetGeneration !== resetGeneration) {
    return {
      providerId: null,
      model: '',
      enabled: true,
      params: {},
      dirty: false,
      resetGeneration,
    };
  }
  if (draft.dirty) return draft;
  return createAiCapabilityDraft(setting, resetGeneration);
}

export function inheritedProviderOptionLabel(
  optIn: boolean,
  effectiveProviderName: string | undefined,
): string {
  if (optIn) return 'No provider override (opt-in disabled)';
  return effectiveProviderName
    ? `Inherit group (${effectiveProviderName})`
    : 'Inherit group (no provider configured)';
}
