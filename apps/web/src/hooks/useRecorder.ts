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
  // Live level source for the waveform; set while recording, null otherwise.
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set by cancel(): the onstop handler discards the take instead of keeping it.
  const discardRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    setAnalyser(null);
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
      cleanup();
      if (discardRef.current) {
        discardRef.current = false;
        setRecording(null);
        setElapsedSeconds(0);
        setState('idle');
        return;
      }
      const type = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      setRecording({
        blob,
        contentType: type.split(';')[0].trim(),
        startedAt,
      });
      setState('stopped');
    };

    // Tap the stream for the live waveform. Analyser only — never connected
    // to the output, so there is no feedback loop.
    try {
      const audioCtx = new AudioContext();
      const analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;
      audioCtx.createMediaStreamSource(stream).connect(analyserNode);
      audioCtxRef.current = audioCtx;
      setAnalyser(analyserNode);
    } catch {
      // Visualization is a nice-to-have; recording works without it.
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    discardRef.current = false;
    setRecording(null);
    setElapsedSeconds(0);
    recorder.start();
    setState('recording');
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
  }, [cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  /** Stop and throw the take away (no `recording` is produced). */
  const cancel = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      discardRef.current = true;
      recorderRef.current.stop();
      return;
    }
    cleanup();
    setRecording(null);
    setElapsedSeconds(0);
    setState('idle');
  }, [cleanup]);

  const reset = useCallback(() => {
    cleanup();
    setRecording(null);
    setElapsedSeconds(0);
    setState('idle');
  }, [cleanup]);

  return { state, elapsedSeconds, recording, analyser, start, stop, cancel, reset };
}
