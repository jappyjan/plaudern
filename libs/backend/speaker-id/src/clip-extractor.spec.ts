import { pickSegments } from './clip-extractor';

describe('pickSegments', () => {
  it('prefers the longest segments up to the cap, replayed chronologically', () => {
    const segments = [
      { start: 0, end: 2 }, // 2s
      { start: 10, end: 30 }, // 20s — longest, picked first
      { start: 40, end: 55 }, // 15s — picked second, cap reached
      { start: 60, end: 61 }, // 1s
    ];
    expect(pickSegments(segments, 30)).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 55 },
    ]);
  });

  it('keeps adding segments until the total reaches the cap', () => {
    const segments = [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ];
    // 4s + 4s < 10s cap, so a third segment is still added.
    expect(pickSegments(segments, 10)).toHaveLength(3);
  });

  it('returns nothing for an empty segment list', () => {
    expect(pickSegments([], 30)).toEqual([]);
  });
});
