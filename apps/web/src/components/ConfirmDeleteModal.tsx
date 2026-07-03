import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';

interface ConfirmDeleteModalProps {
  isOpen: boolean;
  title?: string;
  message?: string;
  isDeleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmation dialog for destructive deletes. The caller drives the API call. */
export function ConfirmDeleteModal({
  isOpen,
  title = 'Delete item?',
  message = 'This permanently removes the recording, its transcription and the stored file. This cannot be undone.',
  isDeleting,
  error,
  onConfirm,
  onClose,
}: ConfirmDeleteModalProps) {
  return (
    // disableAnimation: on iOS PWAs framer-motion's AnimatePresence drops the
    // open on a quick tap, so the modal never appears (heroui-inc/heroui#3222).
    <Modal disableAnimation isOpen={isOpen} onClose={isDeleting ? undefined : onClose}>
      <ModalContent>
        <ModalHeader>{title}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-600">{message}</p>
          {error && <p className="text-sm text-danger">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={isDeleting}>
            Cancel
          </Button>
          <Button color="danger" onPress={onConfirm} isLoading={isDeleting}>
            Delete
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
