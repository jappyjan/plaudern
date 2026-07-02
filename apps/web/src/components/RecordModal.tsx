import { useMemo, useState } from 'react';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Progress,
} from '@heroui/react';
import { useIngest } from '../hooks/useIngest';
import { useRecorder } from '../hooks/useRecorder';
import { getLocationOrNull } from '../lib/geolocation';
import { formatDuration } from '../lib/format';
import { MicIcon, StopIcon } from './icons';

interface RecordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (inboxItemId: string) => void;
}

const PHASE_LABEL: Record<string, string> = {
  init: 'Preparing…',
  uploading: 'Uploading…',
  committing: 'Finishing…',
};

export function RecordModal({ isOpen, onClose, onSaved }: RecordModalProps) {
  const recorder = useRecorder();
  const { phase, progress, error, ingest, reset: resetIngest } = useIngest();
  // One key per take: retrying a failed save of the same take stays idempotent.
  const [takeKey, setTakeKey] = useState<string | null>(null);

  const previewUrl = useMemo(
    () => (recorder.recording ? URL.createObjectURL(recorder.recording.blob) : null),
    [recorder.recording],
  );

  const busy = phase === 'init' || phase === 'uploading' || phase === 'committing';

  const close = () => {
    if (busy) return;
    recorder.reset();
    resetIngest();
    setTakeKey(null);
    onClose();
  };

  const startRecording = async () => {
    setTakeKey(crypto.randomUUID());
    await recorder.start();
  };

  const save = async () => {
    if (!recorder.recording || !takeKey) return;
    const location = await getLocationOrNull();
    const itemId = await ingest({
      blob: recorder.recording.blob,
      contentType: recorder.recording.contentType,
      sourceType: 'audio',
      occurredAt: recorder.recording.startedAt,
      idempotencyKey: takeKey,
      metadata: {
        capturedVia: 'browser-recording',
        ...(location ? { location } : {}),
        device: { userAgent: navigator.userAgent },
      },
    });
    if (itemId) {
      recorder.reset();
      resetIngest();
      setTakeKey(null);
      onSaved(itemId);
      onClose();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} placement="center" isDismissable={!busy}>
      <ModalContent>
        <ModalHeader>Record a note</ModalHeader>
        <ModalBody className="items-center gap-4 py-6">
          {recorder.state === 'unsupported' && (
            <p className="text-center text-sm text-danger">
              This browser does not support audio recording.
            </p>
          )}
          {recorder.state === 'denied' && (
            <p className="text-center text-sm text-danger">
              Microphone access was denied. Allow it in the browser settings and try again.
            </p>
          )}

          {(recorder.state === 'idle' || recorder.state === 'denied') && (
            <Button
              color="danger"
              size="lg"
              radius="full"
              className="h-20 w-20"
              isIconOnly
              aria-label="Start recording"
              onPress={startRecording}
            >
              <MicIcon className="h-8 w-8" />
            </Button>
          )}

          {recorder.state === 'recording' && (
            <>
              <p className="text-3xl font-semibold tabular-nums">
                {formatDuration(recorder.elapsedSeconds)}
              </p>
              <Button
                color="danger"
                variant="flat"
                size="lg"
                radius="full"
                className="h-20 w-20"
                isIconOnly
                aria-label="Stop recording"
                onPress={recorder.stop}
              >
                <StopIcon className="h-8 w-8" />
              </Button>
              <p className="text-xs text-default-500">Recording… tap to stop</p>
            </>
          )}

          {recorder.state === 'stopped' && previewUrl && (
            <>
              <audio controls src={previewUrl} className="w-full" />
              {busy && (
                <div className="w-full">
                  <Progress
                    aria-label={PHASE_LABEL[phase] ?? 'Saving'}
                    value={phase === 'uploading' ? progress * 100 : undefined}
                    isIndeterminate={phase !== 'uploading'}
                    size="sm"
                  />
                  <p className="mt-1 text-center text-xs text-default-500">
                    {PHASE_LABEL[phase]}
                  </p>
                </div>
              )}
              {error && <p className="text-center text-sm text-danger">{error}</p>}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          {recorder.state === 'stopped' && (
            <>
              <Button variant="light" isDisabled={busy} onPress={recorder.reset}>
                Discard
              </Button>
              <Button color="primary" isLoading={busy} onPress={save}>
                Save to inbox
              </Button>
            </>
          )}
          {recorder.state !== 'stopped' && (
            <Button variant="light" onPress={close}>
              Close
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
