import exifr from 'exifr';

/** Only this many bytes are loaded per file. EXIF/XMP almost always sits in the header. */
export const HEADER_BYTES = 2 * 1024 * 1024;

const PARSE_OPTIONS = {
  tiff: true,
  xmp: true,
  icc: false,
  iptc: true,
  jfif: false,
  ihdr: true,
  gps: true,
  interop: true,
  translateKeys: true,
  translateValues: true,
  reviveValues: false,
  sanitize: false,
  mergeOutput: true,
  silentErrors: true,
} as const;

const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LON_REF = 3;
const GPS_LON = 4;
const GPS_ALT_REF = 5;
const GPS_ALT = 6;
const EXIF_IFD = 0x8769;
const GPS_IFD = 0x8825;
const DATETIME_ORIGINAL = 36867;
const OFFSET_TIME_ORIGINAL = 36881;

const IFD0_NAMES: Record<number, string> = {
  256: 'ImageWidth',
  257: 'ImageLength',
  271: 'Make',
  272: 'Model',
  274: 'Orientation',
};

const EXIF_NAMES: Record<number, string> = {
  33434: 'ExposureTime',
  33437: 'FNumber',
  34855: 'ISO',
  36867: 'DateTimeOriginal',
  36881: 'OffsetTimeOriginal',
  37386: 'FocalLength',
  40962: 'ExifImageWidth',
  40963: 'ExifImageHeight',
  42036: 'LensModel',
};

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

export type GpsFix = {
  latitude: number | null;
  longitude: number | null;
  altitude_m: number | null;
};

export type ExifIfds = {
  ifd0: Record<number, unknown>;
  exif: Record<number, unknown>;
  gps: Record<number, unknown>;
};

function textValue(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function flatten(
  value: unknown,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (value == null) return out;
  if (Array.isArray(value) || typeof value !== 'object' || value instanceof Date) {
    if (prefix) out[prefix] = value instanceof Date ? textValue(value) : value;
    return out;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}:${key}` : key;
    if (
      nested != null &&
      typeof nested === 'object' &&
      !(nested instanceof Date) &&
      !Array.isArray(nested)
    ) {
      flatten(nested, next, out);
    } else {
      out[next] = nested instanceof Date ? textValue(nested) : nested;
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string | number, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return null;
  }
  return value as Record<string | number, unknown>;
}

function namedTag(ifd: Record<string | number, unknown>, leaf: string): unknown {
  if (ifd[leaf] != null) return ifd[leaf];
  for (const [key, value] of Object.entries(ifd)) {
    if (key.split(':').pop() === leaf && value != null) return value;
  }
  return undefined;
}

function ifdValue(
  ifd: Record<string | number, unknown>,
  tag: number,
  ...names: string[]
): unknown {
  for (const name of names) {
    const named = namedTag(ifd, name);
    if (named != null) return named;
  }
  if (Object.prototype.hasOwnProperty.call(ifd, tag) && ifd[tag] != null) return ifd[tag];
  const asString = String(tag);
  if (Object.prototype.hasOwnProperty.call(ifd, asString) && ifd[asString] != null) {
    return ifd[asString];
  }
  return undefined;
}

function stripNull(value: string): string {
  return value.replaceAll('\x00', '').trim();
}

function rationalToFloat(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length === 2) {
    const num = Number(value[0]);
    const den = Number(value[1]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
    return num / den;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dmsToDecimal(dms: unknown): number | null {
  if (typeof dms === 'number' && Number.isFinite(dms)) return dms;
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const [degrees, minutes, seconds] = dms.map(rationalToFloat);
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  return degrees + minutes / 60 + seconds / 3600;
}

function refStr(ref: unknown): string {
  if (ref instanceof Uint8Array || ref instanceof ArrayBuffer) {
    const bytes = ref instanceof Uint8Array ? ref : new Uint8Array(ref);
    ref = new TextDecoder().decode(bytes);
  }
  if (ArrayBuffer.isView(ref) && !(ref instanceof DataView)) {
    ref = new TextDecoder().decode(new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength));
  }
  return stripNull(String(ref ?? '')).toUpperCase();
}

/** W/West and S/South always use the negative hemisphere; never double-flip. */
export function applyHemisphere(value: number, ref: unknown, southOrWest: 'S' | 'W'): number {
  const r = refStr(ref);
  if (!r) return value;
  return r.startsWith(southOrWest) ? -Math.abs(value) : Math.abs(value);
}

function altitudeRef(value: unknown): number {
  if (value instanceof Uint8Array) return value[0] ?? 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value)[0] ?? 0;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)[0] ?? 0;
  }
  if (typeof value === 'string' && value.length) return value.charCodeAt(0) === 1 ? 1 : Number(value) || 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Decode GPS IFD tags 1–6 into decimal degrees and metres, matching Pillow. */
export function extractGps(gpsIfd: Record<string | number, unknown>): GpsFix {
  let latitude: number | null = null;
  let longitude: number | null = null;
  let altitude_m: number | null = null;

  const latDms = ifdValue(gpsIfd, GPS_LAT, 'GPSLatitude');
  const lonDms = ifdValue(gpsIfd, GPS_LON, 'GPSLongitude');
  if (latDms != null && lonDms != null) {
    const lat = dmsToDecimal(latDms);
    const lon = dmsToDecimal(lonDms);
    if (lat != null && lon != null) {
      latitude = applyHemisphere(lat, ifdValue(gpsIfd, GPS_LAT_REF, 'GPSLatitudeRef') ?? 'N', 'S');
      longitude = applyHemisphere(lon, ifdValue(gpsIfd, GPS_LON_REF, 'GPSLongitudeRef') ?? 'E', 'W');
    }
  }

  const altVal = ifdValue(gpsIfd, GPS_ALT, 'GPSAltitude');
  if (altVal != null) {
    altitude_m = rationalToFloat(altVal);
    if (altitudeRef(ifdValue(gpsIfd, GPS_ALT_REF, 'GPSAltitudeRef') ?? 0) === 1) {
      altitude_m = -altitude_m;
    }
  }

  return { latitude, longitude, altitude_m };
}

/** DateTimeOriginal plus OffsetTimeOriginal when present. */
export function extractCaptureTime(exifIfd: Record<string | number, unknown>): string | null {
  const raw = ifdValue(exifIfd, DATETIME_ORIGINAL, 'DateTimeOriginal');
  if (raw == null || raw === '') return null;
  const dateOriginal =
    raw instanceof Date && !Number.isNaN(raw.getTime()) ? raw.toISOString() : stripNull(String(raw));
  if (!dateOriginal) return null;
  const offset = ifdValue(exifIfd, OFFSET_TIME_ORIGINAL, 'OffsetTimeOriginal');
  if (offset != null && offset !== '' && !/(?:[+-]\d{2}:\d{2}|Z)$/.test(dateOriginal)) {
    return dateOriginal + stripNull(String(offset));
  }
  return dateOriginal;
}

function isTiffHeader(bytes: Uint8Array, offset: number): boolean {
  if (offset + 8 > bytes.length) return false;
  const le = bytes[offset] === 0x49 && bytes[offset + 1] === 0x49 && bytes[offset + 2] === 0x2a && bytes[offset + 3] === 0;
  const be = bytes[offset] === 0x4d && bytes[offset + 1] === 0x4d && bytes[offset + 2] === 0 && bytes[offset + 3] === 0x2a;
  return le || be;
}

function u16(view: DataView, offset: number, le: boolean): number {
  if (offset + 2 > view.byteLength) return 0;
  return view.getUint16(offset, le);
}

function u32(view: DataView, offset: number, le: boolean): number {
  if (offset + 4 > view.byteLength) return 0;
  return view.getUint32(offset, le);
}

function i32(view: DataView, offset: number, le: boolean): number {
  if (offset + 4 > view.byteLength) return 0;
  return view.getInt32(offset, le);
}

function findJpegExifTiff(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return -1;
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const size = (bytes[i + 2] << 8) | bytes[i + 3];
    if (size < 2 || i + 2 + size > bytes.length) break;
    if (marker === 0xe1 && i + 10 <= bytes.length) {
      const start = i + 4;
      if (
        bytes[start] === 0x45 &&
        bytes[start + 1] === 0x78 &&
        bytes[start + 2] === 0x69 &&
        bytes[start + 3] === 0x66 &&
        bytes[start + 4] === 0 &&
        bytes[start + 5] === 0 &&
        isTiffHeader(bytes, start + 6)
      ) {
        return start + 6;
      }
    }
    i += 2 + size;
  }
  return -1;
}

function findPngExifTiff(bytes: Uint8Array): number {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return -1;
  let i = 8;
  while (i + 12 <= bytes.length) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 0 || i + 12 + len > bytes.length) break;
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (type === 'eXIf' && isTiffHeader(bytes, i + 8)) return i + 8;
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return -1;
}

function findEmbeddedExifTiff(bytes: Uint8Array): number {
  const needle = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const last = Math.min(bytes.length - 14, HEADER_BYTES);
  for (let i = 0; i <= last; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match && isTiffHeader(bytes, i + 6)) return i + 6;
  }
  return -1;
}

export function findTiffStart(bytes: Uint8Array): number {
  const jpeg = findJpegExifTiff(bytes);
  if (jpeg >= 0) return jpeg;
  if (isTiffHeader(bytes, 0)) return 0;
  const png = findPngExifTiff(bytes);
  if (png >= 0) return png;
  return findEmbeddedExifTiff(bytes);
}

function readValue(
  view: DataView,
  tiffStart: number,
  entryOffset: number,
  le: boolean,
): unknown {
  const type = u16(view, entryOffset + 2, le);
  const count = u32(view, entryOffset + 4, le);
  const size = (TYPE_SIZE[type] ?? 1) * count;
  const inline = size <= 4;
  const valueOffset = inline ? entryOffset + 8 : tiffStart + u32(view, entryOffset + 8, le);
  if (valueOffset < 0 || valueOffset + size > view.byteLength) return undefined;

  const at = (i: number) => valueOffset + i * (TYPE_SIZE[type] ?? 1);
  switch (type) {
    case 1:
    case 7: {
      const bytes = new Uint8Array(view.buffer, view.byteOffset + valueOffset, size);
      return count === 1 ? bytes[0] : bytes;
    }
    case 2: {
      let text = '';
      for (let i = 0; i < count; i++) {
        const code = view.getUint8(valueOffset + i);
        if (code === 0) break;
        text += String.fromCharCode(code);
      }
      return text;
    }
    case 3: {
      const values = Array.from({ length: count }, (_, i) => u16(view, at(i), le));
      return count === 1 ? values[0] : values;
    }
    case 4: {
      const values = Array.from({ length: count }, (_, i) => u32(view, at(i), le));
      return count === 1 ? values[0] : values;
    }
    case 5:
    case 10: {
      const signed = type === 10;
      const values = Array.from({ length: count }, (_, i) => {
        const off = at(i);
        const num = signed ? i32(view, off, le) : u32(view, off, le);
        const den = signed ? i32(view, off + 4, le) : u32(view, off + 4, le);
        return [num, den] as [number, number];
      });
      return count === 1 ? values[0] : values;
    }
    case 9: {
      const values = Array.from({ length: count }, (_, i) => i32(view, at(i), le));
      return count === 1 ? values[0] : values;
    }
    default:
      return undefined;
  }
}

function readIfd(view: DataView, tiffStart: number, ifdOffset: number, le: boolean): Record<number, unknown> {
  const start = tiffStart + ifdOffset;
  if (start < 0 || start + 2 > view.byteLength) return {};
  const count = u16(view, start, le);
  if (count <= 0 || count > 256) return {};
  const out: Record<number, unknown> = {};
  for (let i = 0; i < count; i++) {
    const entry = start + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = u16(view, entry, le);
    const value = readValue(view, tiffStart, entry, le);
    if (value !== undefined) out[tag] = value;
  }
  return out;
}

/** Walk TIFF IFDs the way Pillow `Image.getexif()` / `get_ifd()` does. */
export function parseExifIfds(bytes: Uint8Array): ExifIfds {
  const empty: ExifIfds = { ifd0: {}, exif: {}, gps: {} };
  const tiffAt = findTiffStart(bytes);
  if (tiffAt < 0) return empty;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[tiffAt] === 0x49;
  const ifd0Offset = u32(view, tiffAt + 4, le);
  const ifd0 = readIfd(view, tiffAt, ifd0Offset, le);
  const exifOffset = ifd0[EXIF_IFD];
  const gpsOffset = ifd0[GPS_IFD];
  const exif =
    typeof exifOffset === 'number' ? readIfd(view, tiffAt, exifOffset, le) : {};
  const gps = typeof gpsOffset === 'number' ? readIfd(view, tiffAt, gpsOffset, le) : {};
  return { ifd0, exif, gps };
}

function namedIfdTags(ifd: Record<number, unknown>, names: Record<number, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tag, name] of Object.entries(names)) {
    const value = ifd[Number(tag)];
    if (value != null) out[name] = value;
  }
  return out;
}

function writeNamed(
  tags: Record<string, unknown>,
  leaf: string,
  value: unknown,
): void {
  tags[leaf] = value;
  for (const key of Object.keys(tags)) {
    if (key.split(':').pop() === leaf) tags[key] = value;
  }
}

function applyGpsAndTime(
  tags: Record<string, unknown>,
  gpsIfd: Record<string | number, unknown>,
  exifIfd: Record<string | number, unknown>,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const gps = extractGps(gpsIfd);
  const fallback = extractGps(tags);
  const latRef =
    ifdValue(gpsIfd, GPS_LAT_REF, 'GPSLatitudeRef') ?? namedTag(tags, 'GPSLatitudeRef');
  const lonRef =
    ifdValue(gpsIfd, GPS_LON_REF, 'GPSLongitudeRef') ?? namedTag(tags, 'GPSLongitudeRef');
  let lat =
    gps.latitude ??
    fallback.latitude ??
    (typeof parsed.latitude === 'number' ? parsed.latitude : null);
  let lng =
    gps.longitude ??
    fallback.longitude ??
    (typeof parsed.longitude === 'number' ? parsed.longitude : null);
  if (lat != null) lat = applyHemisphere(lat, latRef, 'S');
  if (lng != null) lng = applyHemisphere(lng, lonRef, 'W');
  const alt = gps.altitude_m ?? fallback.altitude_m;
  if (lat != null) writeNamed(tags, 'GPSLatitude', lat);
  if (lng != null) writeNamed(tags, 'GPSLongitude', lng);
  if (alt != null) writeNamed(tags, 'GPSAltitude', alt);
  const capture = extractCaptureTime(exifIfd) ?? extractCaptureTime(tags);
  if (capture) writeNamed(tags, 'DateTimeOriginal', capture);
  return tags;
}

export function normalizeTags(parsed: Record<string, unknown>): Record<string, unknown> {
  const tags = flatten(parsed);
  const gpsIfd = asRecord(parsed.gps) ?? parsed;
  const exifIfd = asRecord(parsed.exif) ?? parsed;
  return applyGpsAndTime(tags, gpsIfd, exifIfd, parsed);
}

function tagsFromIfds(ifds: ExifIfds): Record<string, unknown> {
  const tags = {
    ...namedIfdTags(ifds.ifd0, IFD0_NAMES),
    ...namedIfdTags(ifds.exif, EXIF_NAMES),
  };
  return applyGpsAndTime(tags, ifds.gps, ifds.exif, {});
}

export async function readFileMetadata(file: File): Promise<Record<string, unknown>> {
  const header = file.size > HEADER_BYTES ? file.slice(0, HEADER_BYTES) : file;
  const bytes = new Uint8Array(await header.arrayBuffer());
  const fromIfd = tagsFromIfds(parseExifIfds(bytes));
  let fromParser: Record<string, unknown> = {};
  try {
    const parsed = (await exifr.parse(bytes, PARSE_OPTIONS)) as Record<string, unknown> | undefined;
    if (parsed && typeof parsed === 'object') fromParser = normalizeTags(parsed);
  } catch {
    fromParser = {};
  }
  const merged = { ...fromParser, ...fromIfd };
  return applyGpsAndTime(merged, merged, merged, merged);
}
