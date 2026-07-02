import { useCallback, useEffect, useRef, useState } from 'react';

export interface Recording {
  blob: Blob;
  /** Actual recorder mime type with any `;codecs=` suffix stripped. */
  contentType: string;
  /** ISO timestamp of when recording started — the occurredAt of the note. */
  startedAt: string;
}

type RecorderState = 'idle' | 'recording' | 'stopped' | 'unsupported' | 'denied';

// Safari only supports audio/mp4; Chrome/Firefox record webm/opus.
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('denied');
      return;
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const startedAt = new Date().toISOString();
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      setRecording({
        blob,
        contentType: type.split(';')[0].trim(),
        startedAt,
      });
      setState('stopped');
      cleanup();
    };

    streamRef.current = stream;
    recorderRef.current = recorder;
    setRecording(null);
    setElapsedSeconds(0);
    recorder.start();
    setState('recording');
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
  }, [cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setRecording(null);
    setElapsedSeconds(0);
    setState('idle');
  }, [cleanup]);

  return { state, elapsedSeconds, recording, start, stop, reset };
}
