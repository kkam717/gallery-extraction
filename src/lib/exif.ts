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
  reviveValues: true,
  sanitize: false,
  mergeOutput: true,
  silentErrors: true,
} as const;

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

function dmsToDecimal(value: unknown, ref?: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const sign = ref === 'S' || ref === 'W' ? -1 : 1;
    return value * sign;
  }
  if (Array.isArray(value) && value.length >= 3) {
    const [deg, min, sec] = value.map(Number);
    if (![deg, min, sec].every(Number.isFinite)) return null;
    let decimal = Math.abs(deg) + min / 60 + sec / 3600;
    if (deg < 0 || ref === 'S' || ref === 'W') decimal = -decimal;
    return decimal;
  }
  return null;
}

export function normalizeTags(parsed: Record<string, unknown>): Record<string, unknown> {
  const tags = flatten(parsed);
  const lat =
    typeof parsed.latitude === 'number'
      ? parsed.latitude
      : dmsToDecimal(
          parsed.GPSLatitude ?? tags.GPSLatitude,
          parsed.GPSLatitudeRef ?? tags.GPSLatitudeRef,
        );
  const lng =
    typeof parsed.longitude === 'number'
      ? parsed.longitude
      : dmsToDecimal(
          parsed.GPSLongitude ?? tags.GPSLongitude,
          parsed.GPSLongitudeRef ?? tags.GPSLongitudeRef,
        );
  if (lat != null) tags.GPSLatitude = lat;
  if (lng != null) tags.GPSLongitude = lng;
  const alt = parsed.GPSAltitude ?? tags.GPSAltitude;
  if (alt != null) tags.GPSAltitude = alt;
  return tags;
}

export async function readFileMetadata(file: File): Promise<Record<string, unknown>> {
  const header = file.size > HEADER_BYTES ? file.slice(0, HEADER_BYTES) : file;
  const bytes = new Uint8Array(await header.arrayBuffer());
  const parsed = (await exifr.parse(bytes, PARSE_OPTIONS)) as
    | Record<string, unknown>
    | undefined;
  if (!parsed || typeof parsed !== 'object') return {};
  return normalizeTags(parsed);
}
