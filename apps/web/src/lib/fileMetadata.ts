import { parseBlob } from 'music-metadata';
import type { GeoLocation } from './geolocation';

export interface ExtractedFileMetadata {
  /** Recording time from embedded tags, full ISO 8601. Absent when untagged. */
  occurredAt?: string;
  /** GPS from embedded tags (QuickTime/MP4 ISO 6709). Absent otherwise. */
  location?: GeoLocation & { alt?: number };
  /** Recording device / encoder info from embedded tags. */
  device?: Record<string, string>;
  /** Curated common tags useful for finding the recording later. */
  tags?: Record<string, unknown>;
}

/**
 * Best-effort extraction of capture metadata embedded in the file itself
 * (ID3, MP4/QuickTime atoms, Vorbis comments). E.g. iPhone Voice Memos embed
 * the creation date; iPhone videos embed ISO 6709 GPS and device make/model.
 * Never throws — an unparseable file simply yields {}.
 */
export async function extractFileMetadata(file: File): Promise<ExtractedFileMetadata> {
  try {
    const parsed = await parseBlob(file, { skipCovers: true });
    const result: ExtractedFileMetadata = {};
    const { common, format, native } = parsed;

    const nativeTags = new Map<string, unknown>();
    for (const tagList of Object.values(native)) {
      for (const tag of tagList) nativeTags.set(tag.id.toLowerCase(), tag.value);
    }

    const occurredAt = parseTagDate(
      common.date ?? common.originaldate ?? nativeTags.get('com.apple.quicktime.creationdate'),
    );
    if (occurredAt) result.occurredAt = occurredAt;

    const location = parseIso6709(
      nativeTags.get('com.apple.quicktime.location.iso6709') ?? nativeTags.get('©xyz'),
    );
    if (location) result.location = location;

    const device: Record<string, string> = {};
    const make = nativeTags.get('com.apple.quicktime.make');
    const model = nativeTags.get('com.apple.quicktime.model');
    const software = nativeTags.get('com.apple.quicktime.software') ?? common.encodedby;
    if (typeof make === 'string') device.make = make;
    if (typeof model === 'string') device.model = model;
    if (typeof software === 'string') device.software = software;
    if (typeof common.encodersettings === 'string') device.encoder = common.encodersettings;
    if (Object.keys(device).length > 0) result.device = device;

    const tags: Record<string, unknown> = {};
    if (common.title) tags.title = common.title;
    if (common.artist) tags.artist = common.artist;
    if (common.album) tags.album = common.album;
    if (common.genre?.length) tags.genre = common.genre;
    if (common.comment?.length) {
      tags.comment = common.comment.map((c) => c.text ?? '').filter(Boolean);
    }
    if (typeof format.duration === 'number') tags.durationSeconds = format.duration;
    if (Object.keys(tags).length > 0) result.tags = tags;

    return result;
  } catch {
    return {};
  }
}

/** Normalise a tag date ('2024', '2024-05-01', Date, ...) to full ISO, or null. */
function parseTagDate(value: unknown): string | null {
  if (value == null) return null;
  const raw = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(raw.getTime()) || raw.getFullYear() < 1971) return null;
  return raw.toISOString();
}

/** Parse an ISO 6709 location string like "+52.5200+013.4050+034.000/". */
function parseIso6709(value: unknown): (GeoLocation & { alt?: number }) | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  const location: GeoLocation & { alt?: number } = { lat, lon };
  if (match[3]) location.alt = Number(match[3]);
  return location;
}
