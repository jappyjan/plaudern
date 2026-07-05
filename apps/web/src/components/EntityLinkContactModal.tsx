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
import type {
  EntityContactSuggestionDto,
  EntityDetailWithRelationsDto,
  VoiceProfileDto,
} from '@plaudern/contracts';
import { getEntityContactSuggestions, linkEntityContact, listSpeakers } from '../lib/api';
import { speakerColor } from '../lib/speakerColors';

interface EntityLinkContactModalProps {
  isOpen: boolean;
  entity: EntityDetailWithRelationsDto;
  onClose: () => void;
  onLinked: (entity: EntityDetailWithRelationsDto) => void;
}

interface ContactRow {
  contact: VoiceProfileDto;
  suggestion: EntityContactSuggestionDto | null;
}

/**
 * Manually link a person entity to a contact from the voice-profile contact
 * book. The identity resolver's ranked suggestions (name affinity, whose
 * voice is in the recordings, shared knowledge-graph connections) sort first
 * with their confidence and evidence; a search box covers the rest.
 */
export function EntityLinkContactModal({
  isOpen,
  entity,
  onClose,
  onLinked,
}: EntityLinkContactModalProps) {
  const [contacts, setContacts] = useState<VoiceProfileDto[] | null>(null);
  const [suggestions, setSuggestions] = useState<Map<string, EntityContactSuggestionDto>>(
    new Map(),
  );
  const [query, setQuery] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setContacts(null);
    setSuggestions(new Map());
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
    // Suggestions are enrichment: if the call fails the plain list still works.
    void (async () => {
      try {
        const res = await getEntityContactSuggestions(entity.id);
        if (!cancelled) {
          setSuggestions(new Map(res.suggestions.map((s) => [s.voiceProfileId, s])));
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, entity.id]);

  const rows = useMemo<ContactRow[]>(() => {
    if (!contacts) return [];
    const needle = query.trim().toLowerCase();
    return contacts
      .filter((c) => !needle || (c.name ?? '').toLowerCase().includes(needle))
      .map((contact) => ({ contact, suggestion: suggestions.get(contact.id) ?? null }))
      .sort((a, b) => {
        const confidence = (b.suggestion?.confidence ?? -1) - (a.suggestion?.confidence ?? -1);
        if (confidence !== 0) return confidence;
        return (a.contact.name ?? '~').localeCompare(b.contact.name ?? '~');
      });
  }, [contacts, query, suggestions]);

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
              {rows.map(({ contact, suggestion }) => (
                <button
                  key={contact.id}
                  type="button"
                  disabled={linking !== null}
                  onClick={() => void link(contact)}
                  className="flex items-start gap-3 rounded-medium p-2 text-left hover:bg-default-100 disabled:opacity-60"
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
                      {suggestion
                        ? suggestion.reasons.join(' · ')
                        : `${contact.recordingCount} recording${contact.recordingCount === 1 ? '' : 's'}`}
                    </span>
                  </span>
                  {suggestion && (
                    <Chip
                      size="sm"
                      variant="flat"
                      color="primary"
                      className="shrink-0"
                      title="Identity-resolver confidence"
                    >
                      {Math.round(suggestion.confidence * 100)}%
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
