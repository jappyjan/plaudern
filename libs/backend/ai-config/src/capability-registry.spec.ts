import {
  ALL_CAPABILITY_KINDS,
  capabilitiesOfKind,
  capabilityGroupMeta,
  capabilityMeta,
} from './capability-registry';

describe('capability registry group policy', () => {
  it('only advertises group protocols supported by every member the resolver can inherit into', () => {
    for (const kind of ALL_CAPABILITY_KINDS) {
      const group = capabilityGroupMeta(kind);
      for (const protocol of group.compatibleProtocols) {
        for (const capability of capabilitiesOfKind(kind)) {
          expect(capabilityMeta(capability).compatibleProtocols).toContain(protocol);
        }
      }
    }
  });

  it('keeps every group primary inside its resolver kind', () => {
    for (const kind of ALL_CAPABILITY_KINDS) {
      expect(capabilityMeta(capabilityGroupMeta(kind).primary).kind).toBe(kind);
    }
  });
});
