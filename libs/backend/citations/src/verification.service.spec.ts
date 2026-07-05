import { VerificationService } from './verification.service';
import type { CitationVerifier, VerificationResult } from './verification.provider';

function fakeVerifier(overrides: Partial<CitationVerifier> = {}): CitationVerifier {
  return {
    id: 'fake',
    enabled: true,
    verify: async (): Promise<VerificationResult> => ({ fields: [] }),
    ...overrides,
  };
}

describe('VerificationService', () => {
  it('skips (ran: false) when the verifier is disabled', async () => {
    const service = new VerificationService(fakeVerifier({ enabled: false }));
    expect(service.enabled).toBe(false);
    const outcome = await service.verifyHighStakes('The rent is 900 euros [1].', ['rent 900']);
    expect(outcome).toEqual({ ran: false, unsupported: [] });
  });

  it('skips when there are no usable passages', async () => {
    const verify = jest.fn();
    const service = new VerificationService(fakeVerifier({ verify }));
    const outcome = await service.verifyHighStakes('Something [1].', ['', '   ']);
    expect(outcome.ran).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns the unsupported high-stakes values the judge flagged', async () => {
    const service = new VerificationService(
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
    const outcome = await service.verifyHighStakes('answer', ['passage']);
    expect(outcome.ran).toBe(true);
    expect(outcome.unsupported).toEqual(['900 euros', 'Karsten']);
  });

  it('degrades to ran: false when the verifier throws (never breaks generation)', async () => {
    const service = new VerificationService(
      fakeVerifier({
        verify: async () => {
          throw new Error('network down');
        },
      }),
    );
    const outcome = await service.verifyHighStakes('answer', ['passage']);
    expect(outcome).toEqual({ ran: false, unsupported: [] });
  });
});
