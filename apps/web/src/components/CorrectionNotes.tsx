import { useCallback, useEffect, useState } from 'react';
import { Button, Textarea } from '@heroui/react';
import type { CorrectionNoteDto } from '@plaudern/contracts';
import { addCorrectionNote, deleteCorrectionNote, listCorrectionNotes } from '../lib/api';
import { TrashIcon } from './icons';

/**
 * Correction notes for one inbox item, shown with the summary: free-text
 * remarks ("the name is 'Meier', not 'Maier'") that the AI applies as
 * authoritative fixes on the next summary generation. Adding or removing a
 * note queues that regeneration server-side; `onSummaryQueued` lets the
 * summary view restart its polling so the corrected summary appears live.
 * The source (recording, note, scan) itself is never modified.
 */
export function CorrectionNotes({
  itemId,
  onSummaryQueued,
}: {
  itemId: string;
  onSummaryQueued?: () => void;
}) {
  const [notes, setNotes] = useState<CorrectionNoteDto[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setNotes((await listCorrectionNotes(itemId)).notes);
    } catch {
      // A failed notes load must not break the summary tab; the add flow
      // surfaces its own errors.
      setNotes([]);
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const result = await addCorrectionNote(itemId, body);
      setNotes(result.notes);
      setDraft('');
      if (result.summaryQueued) onSummaryQueued?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (noteId: string) => {
    setDeletingId(noteId);
    setError(null);
    try {
      const result = await deleteCorrectionNote(itemId, noteId);
      setNotes(result.notes);
      if (result.summaryQueued) onSummaryQueued?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-default-400">
        Spotted a mistake — a misheard name, a wrong number, a misread scan? Add a note and the
        summary is regenerated with the correction applied. The original recording, note or
        document stays untouched.
      </p>

      {notes && notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {notes.map((note) => (
            <li
              key={note.id}
              className="flex items-start justify-between gap-2 rounded-medium bg-default-100 px-3 py-2"
            >
              <p className="whitespace-pre-wrap text-sm">{note.body}</p>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="Delete note"
                isLoading={deletingId === note.id}
                isDisabled={deletingId !== null}
                onPress={() => void remove(note.id)}
              >
                <TrashIcon className="h-4 w-4 text-default-400" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        <Textarea
          aria-label="Correction note"
          placeholder="e.g. The name is 'Meier', not 'Maier'."
          size="sm"
          minRows={1}
          value={draft}
          onValueChange={setDraft}
        />
        <Button
          size="sm"
          color="primary"
          variant="flat"
          className="self-start"
          isLoading={busy}
          isDisabled={busy || draft.trim().length === 0}
          onPress={() => void add()}
        >
          Add note & regenerate
        </Button>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
