import type { AiCapabilitySettingDto } from '@plaudern/contracts';
import {
  createAiCapabilityDraft,
  inheritedProviderOptionLabel,
  reconcileAiCapabilityDraft,
} from './ai-capability-draft';

function setting(providerId: string | null, model: string | null): AiCapabilitySettingDto {
  return {
    capability: 'summarization',
    override: { providerId, model, timeoutMs: null, enabled: true, params: {} },
    effective: {
      providerId,
      providerSource: providerId ? 'capability' : null,
      model: model ?? 'default-model',
      modelSource: model ? 'capability' : 'registry',
      timeoutMs: 120_000,
      params: {},
    },
    active: providerId !== null,
    inactiveReason: providerId ? null : 'no-provider',
  };
}

describe('AI capability draft reconciliation', () => {
  it('reseeds a mounted dirty row after overrides are reset', () => {
    const stale = {
      ...createAiCapabilityDraft(setting('00000000-0000-0000-0000-000000000001', 'special'), 0),
      dirty: true,
    };

    expect(reconcileAiCapabilityDraft(stale, setting(stale.providerId, 'special'), 1)).toEqual({
      providerId: null,
      model: '',
      enabled: true,
      params: {},
      dirty: false,
      resetGeneration: 1,
    });
  });

  it('preserves intentional unsaved edits during an ordinary group refresh', () => {
    const draft = {
      ...createAiCapabilityDraft(setting(null, null), 0),
      model: 'intentional-unsaved-model',
      dirty: true,
    };
    const refreshed = setting(null, null);
    refreshed.effective.model = 'new-group-model';
    refreshed.effective.modelSource = 'group';

    expect(reconcileAiCapabilityDraft(draft, refreshed, 0)).toBe(draft);
  });

  it('labels inherited providers without presenting them as disabled', () => {
    expect(inheritedProviderOptionLabel(false, 'Shared DeepSeek')).toBe(
      'Inherit group (Shared DeepSeek)',
    );
    expect(inheritedProviderOptionLabel(true, 'Shared DeepSeek')).toBe(
      'No provider override (opt-in disabled)',
    );
  });
});
