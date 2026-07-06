import type { AiConfigService } from '@plaudern/ai-config';
import { VerificationService } from './verification.service';
import type {
  CitationVerifier,
  VerificationInput,
  VerificationResult,
} from './verification.provider';

const USER = 'user-1';

function fakeVerifier(overrides: Partial<CitationVerifier> = {}): CitationVerifier {
  return {
    id: 'fake',
    verify: async (): Promise<VerificationResult> => ({ fields: [] }),
    ...overrides,
  };
}

/** A minimal AiConfigService whose `verification` capability is on/off. */
function fakeAiConfig(enabled: boolean): AiConfigService {
  return {
    resolve: async () => (enabled ? ({} as never) : null),
    isEnabled: async () => enabled,
    invalidate: () => {},
  } as unknown as AiConfigService;
}

function build(enabled: boolean, verifier: CitationVerifier): VerificationService {
  return new VerificationService(verifier, fakeAiConfig(enabled));
}

describe('VerificationService', () => {
  it('skips (ran: false) when the capability is disabled', async () => {
    const service = build(false, fakeVerifier());
    expect(await service.isEnabled(USER)).toBe(false);
    const outcome = await service.verifyHighStakes(USER, 'The rent is 900 euros [1].', ['rent 900']);
    expect(outcome).toEqual({ ran: false, unsupported: [] });
  });

  it('skips when there are no usable passages', async () => {
    const verify = jest.fn();
    const service = build(true, fakeVerifier({ verify }));
    const outcome = await service.verifyHighStakes(USER, 'Something [1].', ['', '   ']);
    expect(outcome.ran).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns the unsupported high-stakes values the judge flagged', async () => {
    const service = build(
      true,
      fakeVerifier({
        verify: async () => ({
          fields: [
            { value: '900 euros', kind: 'amount', supported: false },
            { value: '12 May', kind: 'date', supported: true },
            { value: 'Karsten', kind: 'name', supported: false },
          ],
        }),
      }),
    );
    const outcome = await service.verifyHighStakes(USER, 'answer', ['passage']);
    expect(outcome.ran).toBe(true);
    expect(outcome.unsupported).toEqual(['900 euros', 'Karsten']);
  });

  it('passes the userId through to the verifier', async () => {
    const verify = jest.fn(
      async (_userId: string, _input: VerificationInput): Promise<VerificationResult> => ({
        fields: [],
      }),
    );
    const service = build(true, fakeVerifier({ verify }));
    await service.verifyHighStakes(USER, 'answer', ['passage']);
    expect(verify).toHaveBeenCalledWith(USER, { answer: 'answer', passages: ['passage'] });
  });

  it('degrades to ran: false when the verifier throws (never breaks generation)', async () => {
    const service = build(
      true,
      fakeVerifier({
        verify: async () => {
          throw new Error('network down');
        },
      }),
    );
    const outcome = await service.verifyHighStakes(USER, 'answer', ['passage']);
    expect(outcome).toEqual({ ran: false, unsupported: [] });
  });
});
