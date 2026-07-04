import type { ConfigService } from '@nestjs/config';
import { ContactResolutionStartupService } from './contact-resolution-startup.service';
import type { EntityContactResolverService } from './entity-contact-resolver.service';

function configWith(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function resolverStub(linked = 0): EntityContactResolverService & { calls: number } {
  const stub = {
    calls: 0,
    async autoLinkAllUsers() {
      stub.calls += 1;
      return linked;
    },
  };
  return stub as unknown as EntityContactResolverService & { calls: number };
}

describe('ContactResolutionStartupService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('arms a delayed sweep on bootstrap and runs it', async () => {
    jest.useFakeTimers();
    const resolver = resolverStub(2);
    const service = new ContactResolutionStartupService(
      configWith({ CONTACT_RESOLUTION_STARTUP_DELAY_MS: '50' }),
      resolver,
    );
    service.onApplicationBootstrap();
    expect(resolver.calls).toBe(0); // non-blocking: nothing ran yet
    await jest.advanceTimersByTimeAsync(60);
    expect(resolver.calls).toBe(1);
  });

  it('does nothing when disabled via env', async () => {
    jest.useFakeTimers();
    const resolver = resolverStub();
    const service = new ContactResolutionStartupService(
      configWith({ CONTACT_RESOLUTION_STARTUP_ENABLED: 'false' }),
      resolver,
    );
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(resolver.calls).toBe(0);
  });

  it('cancels a pending sweep on shutdown', async () => {
    jest.useFakeTimers();
    const resolver = resolverStub();
    const service = new ContactResolutionStartupService(
      configWith({ CONTACT_RESOLUTION_STARTUP_DELAY_MS: '50' }),
      resolver,
    );
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60);
    expect(resolver.calls).toBe(0);
  });
});
