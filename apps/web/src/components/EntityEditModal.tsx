import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
} from '@heroui/react';
import type { EntityDetailWithRelationsDto, EntityType } from '@plaudern/contracts';
import { updateEntity } from '../lib/api';
import { ENTITY_TYPE_LABEL, ENTITY_TYPES } from '../lib/entityLabels';

interface EntityEditModalProps {
  isOpen: boolean;
  entity: EntityDetailWithRelationsDto;
  onClose: () => void;
  onSaved: (entity: EntityDetailWithRelationsDto) => void;
}

/**
 * Correct a registry entity (JJ-63): rename it and/or change its type. The
 * previous name is kept as an alias server-side; re-typing away from `person`
 * drops any contact link (the form warns about that).
 */
export function EntityEditModal({ isOpen, entity, onClose, onSaved }: EntityEditModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<EntityType>(entity.type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the draft whenever the modal opens so stale edits never leak in.
  useEffect(() => {
    if (!isOpen) return;
    setName(entity.canonicalName);
    setType(entity.type);
    setError(null);
  }, [isOpen, entity]);

  const close = () => {
    if (saving) return;
    onClose();
  };

  const dirty = name.trim() !== entity.canonicalName || type !== entity.type;
  const dropsLink = Boolean(entity.voiceProfileId) && type !== 'person';

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateEntity(entity.id, {
        ...(trimmed !== entity.canonicalName ? { canonicalName: trimmed } : {}),
        ...(type !== entity.type ? { type } : {}),
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
        <ModalHeader>Edit entity</ModalHeader>
        <ModalBody className="gap-4 py-6">
          <Input
            label="Name"
            value={name}
            onValueChange={setName}
            isDisabled={saving}
            maxLength={200}
            autoFocus
          />
          <Select
            label="Type"
            isDisabled={saving}
            selectedKeys={[type]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (typeof next === 'string') setType(next as EntityType);
            }}
          >
            {ENTITY_TYPES.map((entityType) => (
              <SelectItem key={entityType}>{ENTITY_TYPE_LABEL[entityType]}</SelectItem>
            ))}
          </Select>
          {dropsLink && (
            <p className="text-sm text-warning">
              Changing the type away from Person removes the link to{' '}
              {entity.voiceProfileName ?? 'the contact'}.
            </p>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close} isDisabled={saving}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving} isDisabled={!name.trim() || !dirty}>
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
