import { stitchDiarizations, stitchTranscriptions, type MergePart } from './extraction-stitcher';

const part = (overrides: Partial<MergePart> & Pick<MergePart, 'itemId' | 'offsetSeconds'>): MergePart => ({
  occurrences: [],
  ...overrides,
});

describe('stitchTranscriptions', () => {
  it('joins content and shifts segments onto the merged timeline', () => {
    const result = stitchTranscriptions([
      part({
        itemId: 'a',
        offsetSeconds: 0,
        transcription: {
          content: 'Hello there. ',
          segments: [{ start: 0, end: 4, text: 'Hello there.' }],
          language: 'en',
        },
      }),
      part({
        itemId: 'b',
        offsetSeconds: 10,
        transcription: {
          content: 'Welcome back.',
          segments: [{ start: 1, end: 5, text: 'Welcome back.' }],
          language: 'en',
        },
      }),
    ]);

    expect(result.content).toBe('Hello there.\n\nWelcome back.');
    expect(result.segments).toEqual([
      { start: 0, end: 4, text: 'Hello there.' },
      { start: 11, end: 15, text: 'Welcome back.' },
    ]);
    expect(result.language).toBe('en');
  });

  it('keeps content of parts without segments and drops disagreeing languages', () => {
    const result = stitchTranscriptions([
      part({
        itemId: 'a',
        offsetSeconds: 0,
        transcription: { content: 'Hallo.', segments: null, language: 'de' },
      }),
      part({
        itemId: 'b',
        offsetSeconds: 8,
        transcription: {
          content: 'Hello.',
          segments: [{ start: 0, end: 2, text: 'Hello.' }],
          language: 'en',
        },
      }),
    ]);

    expect(result.content).toBe('Hallo.\n\nHello.');
    expect(result.segments).toEqual([{ start: 8, end: 10, text: 'Hello.' }]);
    expect(result.language).toBeNull();
  });
});

describe('stitchDiarizations', () => {
  it('collapses the same voice profile across parts onto one merged label', () => {
    const result = stitchDiarizations([
      part({
        itemId: 'a',
        offsetSeconds: 0,
        diarization: {
          segments: [
            { start: 0, end: 8, speaker: 'SPEAKER_00' },
            { start: 8, end: 16, speaker: 'SPEAKER_01' },
          ],
        },
        occurrences: [
          { label: 'SPEAKER_00', voiceProfileId: 'profile-constant' },
          { label: 'SPEAKER_01', voiceProfileId: 'profile-a' },
        ],
      }),
      part({
        itemId: 'b',
        offsetSeconds: 16,
        diarization: {
          // In part B the constant voice was labeled _01 — the remap must
          // recognize it by profile, not by label.
          segments: [
            { start: 0, end: 8, speaker: 'SPEAKER_01' },
            { start: 8, end: 16, speaker: 'SPEAKER_00' },
          ],
        },
        occurrences: [
          { label: 'SPEAKER_01', voiceProfileId: 'profile-constant' },
          { label: 'SPEAKER_00', voiceProfileId: 'profile-b' },
        ],
      }),
    ]);

    expect(result.segments).toEqual([
      { start: 0, end: 8, speaker: 'SPEAKER_00' },
      { start: 8, end: 16, speaker: 'SPEAKER_01' },
      { start: 16, end: 24, speaker: 'SPEAKER_00' },
      { start: 24, end: 32, speaker: 'SPEAKER_02' },
    ]);
    expect(result.occurrences).toEqual(
      expect.arrayContaining([
        { label: 'SPEAKER_00', voiceProfileId: 'profile-constant', speakingSeconds: 16 },
        { label: 'SPEAKER_01', voiceProfileId: 'profile-a', speakingSeconds: 8 },
        { label: 'SPEAKER_02', voiceProfileId: 'profile-b', speakingSeconds: 8 },
      ]),
    );
    expect(result.occurrences).toHaveLength(3);
  });

  it('relabels speakers without occurrences consistently but emits no occurrence row', () => {
    const result = stitchDiarizations([
      part({
        itemId: 'a',
        offsetSeconds: 0,
        diarization: {
          segments: [
            { start: 0, end: 3, speaker: 'SPEAKER_00' },
            { start: 3, end: 5, speaker: 'SPEAKER_00' },
          ],
        },
        occurrences: [], // matcher failed / profile deleted
      }),
      part({
        itemId: 'b',
        offsetSeconds: 5,
        diarization: { segments: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }] },
        occurrences: [{ label: 'SPEAKER_00', voiceProfileId: 'profile-b' }],
      }),
    ]);

    // Part A's unidentified speaker keeps one merged label for both segments;
    // part B's speaker is a DIFFERENT person (different identity) and gets
    // the next label plus the only occurrence row.
    expect(result.segments).toEqual([
      { start: 0, end: 3, speaker: 'SPEAKER_00' },
      { start: 3, end: 5, speaker: 'SPEAKER_00' },
      { start: 5, end: 9, speaker: 'SPEAKER_01' },
    ]);
    expect(result.occurrences).toEqual([
      { label: 'SPEAKER_01', voiceProfileId: 'profile-b', speakingSeconds: 4 },
    ]);
  });

  it('ignores segments without a speaker label', () => {
    const result = stitchDiarizations([
      part({
        itemId: 'a',
        offsetSeconds: 0,
        diarization: { segments: [{ start: 0, end: 2 }] },
      }),
    ]);
    expect(result.segments).toEqual([]);
    expect(result.occurrences).toEqual([]);
  });
});
