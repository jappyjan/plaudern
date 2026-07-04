import { useState } from 'react';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from '@heroui/react';
import { ingestText } from '../lib/api';

interface NoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (inboxItemId: string) => void;
}

/**
 * Quick text capture: type a statement straight into the inbox instead of
 * recording or uploading. Saves through the same `ingestText` path the
 * share-target page uses.
 */
export function NoteModal({ isOpen, onClose, onSaved }: NoteModalProps) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per draft: retrying a failed save of the same note stays idempotent.
  const [draftKey, setDraftKey] = useState<string | null>(null);

  const close = () => {
    if (saving) return;
    setText('');
    setError(null);
    setDraftKey(null);
    onClose();
  };

  const save = async () => {
    if (!text.trim()) return;
    const idempotencyKey = draftKey ?? crypto.randomUUID();
    setDraftKey(idempotencyKey);
    setSaving(true);
    setError(null);
    try {
      const item = await ingestText({
        text: text.trim(),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
        metadata: { capturedVia: 'quick-note' },
      });
      setText('');
      setDraftKey(null);
      onSaved(item.id);
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
        <ModalHeader>Add a note</ModalHeader>
        <ModalBody className="gap-4 py-6">
          <Textarea
            label="Note"
            placeholder="Just met Detlef, he is now on vacation for 4 weeks and wants his money back when he comes back…"
            minRows={4}
            value={text}
            onValueChange={setText}
            isDisabled={saving}
            autoFocus
          />
          {error && <p className="text-sm text-danger">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close} isDisabled={saving}>
            Cancel
          </Button>
          <Button
            color="primary"
            onPress={() => void save()}
            isLoading={saving}
            isDisabled={!text.trim()}
          >
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
