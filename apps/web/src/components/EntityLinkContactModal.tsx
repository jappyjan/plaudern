import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import type { EntityDetailWithRelationsDto, VoiceProfileDto } from '@plaudern/contracts';
import { linkEntityContact, listSpeakers } from '../lib/api';
import { speakerColor } from '../lib/speakerColors';

interface EntityLinkContactModalProps {
  isOpen: boolean;
  entity: EntityDetailWithRelationsDto;
  onClose: () => void;
  onLinked: (entity: EntityDetailWithRelationsDto) => void;
}

/** Lowercased, whitespace-collapsed — mirrors the server's normalize(). */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Manually link a person entity to a contact from the voice-profile contact
 * book. Contacts whose name matches the entity (or one of its aliases) sort
 * first as suggestions; a search box covers the rest.
 */
export function EntityLinkContactModal({
  isOpen,
  entity,
  onClose,
  onLinked,
}: EntityLinkContactModalProps) {
  const [contacts, setContacts] = useState<VoiceProfileDto[] | null>(null);
  const [query, setQuery] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setContacts(null);
    setQuery('');
    setError(null);
    void (async () => {
      try {
        const res = await listSpeakers();
        if (!cancelled) setContacts(res.profiles);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Same spirit as the server's auto-matcher: exact or token-prefix name
  // overlap with the entity's name forms marks a contact as suggested.
  const entityNames = useMemo(
    () => [entity.canonicalName, ...entity.aliases].map(normalize),
    [entity],
  );
  const rows = useMemo(() => {
    if (!contacts) return [];
    const needle = query.trim().toLowerCase();
    const suggested = (contact: VoiceProfileDto) => {
      if (!contact.name) return false;
      const name = normalize(contact.name);
      return entityNames.some(
        (n) => n === name || n.startsWith(`${name} `) || name.startsWith(`${n} `),
      );
    };
    return contacts
      .filter((c) => !needle || (c.name ?? '').toLowerCase().includes(needle))
      .map((c) => ({ contact: c, suggested: suggested(c) }))
      .sort((a, b) => {
        if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
        return (a.contact.name ?? '~').localeCompare(b.contact.name ?? '~');
      });
  }, [contacts, query, entityNames]);

  const close = () => {
    if (linking) return;
    onClose();
  };

  const link = async (contact: VoiceProfileDto) => {
    setLinking(contact.id);
    setError(null);
    try {
      const updated = await linkEntityContact(entity.id, contact.id);
      onLinked(updated);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLinking(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} placement="center" isDismissable={!linking}>
      <ModalContent>
        <ModalHeader>Link “{entity.canonicalName}” to a contact</ModalHeader>
        <ModalBody className="gap-3 py-4">
          <Input
            size="sm"
            label="Search contacts"
            value={query}
            onValueChange={setQuery}
            isClearable
            onClear={() => setQuery('')}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          {!contacts ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" label="Loading contacts…" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-4 text-sm text-default-500">
              {contacts.length === 0
                ? 'No contacts yet — contacts appear as voices are heard in recordings.'
                : 'No contacts match your search.'}
            </p>
          ) : (
            <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {rows.map(({ contact, suggested }) => (
                <button
                  key={contact.id}
                  type="button"
                  disabled={linking !== null}
                  onClick={() => void link(contact)}
                  className="flex items-center gap-3 rounded-medium p-2 text-left hover:bg-default-100 disabled:opacity-60"
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${speakerColor(contact.id)}`}
                  >
                    {(contact.name ?? '?').charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {contact.name ?? 'Unnamed contact'}
                    </span>
                    <span className="block text-xs text-default-500">
                      {contact.recordingCount} recording{contact.recordingCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  {suggested && (
                    <Chip size="sm" variant="flat" color="primary" className="shrink-0">
                      suggested
                    </Chip>
                  )}
                  {linking === contact.id && <Spinner size="sm" className="shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close} isDisabled={linking !== null}>
            Cancel
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
