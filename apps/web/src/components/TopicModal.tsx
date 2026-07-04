import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from '@heroui/react';
import type { TopicDto } from '@plaudern/contracts';
import { createTopic, updateTopic } from '../lib/api';

interface TopicModalProps {
  isOpen: boolean;
  /** When set, the modal edits this topic; otherwise it creates a new one. */
  topic?: TopicDto | null;
  onClose: () => void;
  onSaved: (topic: TopicDto) => void;
}

/**
 * Create or rename/edit a taxonomy entry. The same form powers both flows —
 * an existing `topic` prefills the fields and switches to a PATCH on save.
 */
export function TopicModal({ isOpen, topic, onClose, onSaved }: TopicModalProps) {
  const editing = Boolean(topic);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the fields whenever the modal opens (fresh create) or targets a
  // different topic (edit) so stale drafts never leak across dialogs.
  useEffect(() => {
    if (!isOpen) return;
    setName(topic?.name ?? '');
    setDescription(topic?.description ?? '');
    setError(null);
  }, [isOpen, topic]);

  const close = () => {
    if (saving) return;
    onClose();
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSaving(true);
    setError(null);
    try {
      const trimmedDescription = description.trim();
      const saved = topic
        ? await updateTopic(topic.id, {
            name: trimmedName,
            description: trimmedDescription || null,
          })
        : await createTopic({
            name: trimmedName,
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
          });
      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} placement="center" isDismissable={!saving}>
      <ModalContent>
        <ModalHeader>{editing ? 'Edit topic' : 'New topic'}</ModalHeader>
        <ModalBody className="gap-4 py-6">
          <Input
            label="Name"
            placeholder="e.g. Project Falcon"
            value={name}
            onValueChange={setName}
            isDisabled={saving}
            maxLength={120}
            autoFocus
          />
          <Textarea
            label="Description"
            description="Optional. Helps the classifier decide what belongs to this topic."
            placeholder="What this topic or project is about…"
            minRows={3}
            value={description}
            onValueChange={setDescription}
            isDisabled={saving}
            maxLength={2000}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close} isDisabled={saving}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving} isDisabled={!name.trim()}>
            {editing ? 'Save' : 'Create'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
