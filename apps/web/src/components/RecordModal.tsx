import { useEffect, useMemo, useRef, useState } from 'react';
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
import { getLocationOrNull, type GeoLocation } from '../lib/geolocation';
import { formatDuration } from '../lib/format';
import { StopIcon } from './icons';
import { Waveform } from './Waveform';

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

/**
 * One-tap flow: opening the modal immediately starts recording, and stopping
 * immediately saves. The only extra interactions are Cancel (discard while
 * recording) and Retry/Discard if the save fails.
 */
export function RecordModal({ isOpen, onClose, onSaved }: RecordModalProps) {
  const recorder = useRecorder();
  const { phase, progress, error, ingest, reset: resetIngest } = useIngest();
  // One key per take: retrying a failed save of the same take stays idempotent.
  const [takeKey, setTakeKey] = useState<string | null>(null);

  // Guards auto-start against StrictMode double-effects and re-renders.
  const startGateRef = useRef(false);
  // Prevents the auto-save effect from looping after a failed attempt.
  const autoSaveAttemptedRef = useRef(false);
  // GPS is fetched while recording so saving never waits on the location timeout.
  const locationPromiseRef = useRef<Promise<GeoLocation | null>>(Promise.resolve(null));

  const previewUrl = useMemo(
    () => (recorder.recording ? URL.createObjectURL(recorder.recording.blob) : null),
    [recorder.recording],
  );

  const busy = phase === 'init' || phase === 'uploading' || phase === 'committing';

  const close = () => {
    if (busy) return;
    recorder.cancel();
    resetIngest();
    setTakeKey(null);
    startGateRef.current = false;
    autoSaveAttemptedRef.current = false;
    onClose();
  };

  // Auto-start: the Record button already expressed the intent to record.
  useEffect(() => {
    if (!isOpen || startGateRef.current) return;
    if (recorder.state !== 'idle') return;
    startGateRef.current = true;
    autoSaveAttemptedRef.current = false;
    setTakeKey(crypto.randomUUID());
    locationPromiseRef.current = getLocationOrNull();
    void recorder.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, recorder.state]);

  const save = async () => {
    if (!recorder.recording || !takeKey) return;
    const location = await locationPromiseRef.current.catch(() => null);
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
        tags: { durationSeconds: recorder.elapsedSeconds },
      },
    });
    if (itemId) {
      recorder.reset();
      resetIngest();
      setTakeKey(null);
      startGateRef.current = false;
      autoSaveAttemptedRef.current = false;
      onSaved(itemId);
      onClose();
    }
  };

  // Auto-save: a finished take saves itself; the Stop tap was the confirmation.
  useEffect(() => {
    if (!recorder.recording || phase !== 'idle' || autoSaveAttemptedRef.current) return;
    autoSaveAttemptedRef.current = true;
    void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.recording, phase]);

  const saveFailed = recorder.state === 'stopped' && phase === 'error';

  return (
    // disableAnimation: iOS PWAs drop the modal open on a quick tap when
    // framer-motion animates it (heroui-inc/heroui#3222).
    <Modal disableAnimation isOpen={isOpen} onClose={close} placement="center" isDismissable={!busy}>
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

          {recorder.state === 'recording' && (
            <>
              {recorder.analyser && <Waveform analyser={recorder.analyser} />}
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
                aria-label="Stop recording and save"
                onPress={recorder.stop}
              >
                <StopIcon className="h-8 w-8" />
              </Button>
              <p className="text-xs text-default-500">Recording… tap to stop &amp; save</p>
            </>
          )}

          {recorder.state === 'stopped' && busy && (
            <div className="w-full">
              <Progress
                aria-label={PHASE_LABEL[phase] ?? 'Saving'}
                value={phase === 'uploading' ? progress * 100 : undefined}
                isIndeterminate={phase !== 'uploading'}
                size="sm"
              />
              <p className="mt-1 text-center text-xs text-default-500">
                {PHASE_LABEL[phase] ?? 'Saving…'}
              </p>
            </div>
          )}

          {saveFailed && previewUrl && (
            <>
              <p className="text-center text-sm text-danger">{error}</p>
              <audio controls src={previewUrl} className="w-full" />
            </>
          )}
        </ModalBody>
        <ModalFooter>
          {recorder.state === 'recording' && (
            <Button variant="light" onPress={close}>
              Cancel
            </Button>
          )}
          {saveFailed && (
            <>
              <Button variant="light" onPress={close}>
                Discard
              </Button>
              <Button color="primary" onPress={() => void save()}>
                Retry save
              </Button>
            </>
          )}
          {(recorder.state === 'denied' || recorder.state === 'unsupported') && (
            <Button variant="light" onPress={close}>
              Close
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
