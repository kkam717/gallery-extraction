import initSqlJs from 'sql.js';
import { zipSync, strToU8 } from 'fflate';
import { readFileMetadata } from './exif';

function siteOrigin(): string | null {
  return typeof location === 'undefined' ? null : `${location.origin}/`;
}

export function runtimeAsset(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const relative = `${prefix}${path.replace(/^\//, '')}`;
  const origin = siteOrigin();
  return origin ? new URL(relative, origin).href : relative;
}

function yieldThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
export type Mode = 'full' | 'limited';
export type InputFile = { file: File; path: string };
export type Row = Record<string, string | number | null>;
export type ProgressUpdate = {
  phase: string;
  completed: number;
  total: number;
};
export type Result = {
  archive: Uint8Array;
  rows: Row[];
  manifest: Record<string, unknown>;
};
export const MEDIA = new Set(
  'jpg jpeg jpe heic heif hif png gif tif tiff webp avif bmp dng cr2 cr3 crw nef nrw arw sr2 srf raf orf rw2 rwl pef raw srw 3fr fff iiq kdc mos mrw erf x3f jxl jp2 jpf jpx psd mpo mov mp4 m4v avi 3gp 3g2 mts m2ts mpg mpeg mkv webm'.split(
    ' ',
  ),
);
export const extension = (name: string) =>
  name.toLowerCase().split('.').pop() || '';
export const isMedia = (f: InputFile) => MEDIA.has(extension(f.path));
export const isSidecar = (f: InputFile) =>
  ['json', 'xmp'].includes(extension(f.path));
const textValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
};
const FIELDS: Record<string, string[]> = {
  capture_time_original: [
    'DateTimeOriginal',
    'SubSecDateTimeOriginal',
    'CreationDate',
    'CreateDate',
  ],
  camera_make: ['Make'],
  camera_model: ['Model'],
  lens: ['LensModel', 'LensID'],
  width: ['ExifImageWidth', 'ImageWidth'],
  height: ['ExifImageHeight', 'ImageHeight'],
  orientation: ['Orientation'],
  iso: ['ISO'],
  exposure_seconds: ['ExposureTime'],
  aperture: ['FNumber'],
  focal_length_mm: ['FocalLength'],
  mime_type: ['MIMEType'],
  duration_seconds: ['Duration'],
  latitude: ['GPSLatitude'],
  longitude: ['GPSLongitude'],
  altitude_m: ['GPSAltitude'],
};
const NUMBERS = new Set([
  'width',
  'height',
  'orientation',
  'iso',
  'exposure_seconds',
  'aperture',
  'focal_length_mm',
  'duration_seconds',
  'latitude',
  'longitude',
  'altitude_m',
  'file_bytes',
  'sidecar_count',
]);
export const COLUMNS = [
  'contributor_id',
  'photo_id',
  'source',
  'file_name',
  'file_bytes',
  'status',
  ...Object.keys(FIELDS),
  'gallery_capture_time_utc',
  'sidecar_count',
];
export function getTag(raw: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const matches = Object.entries(raw)
      .filter(([k]) => k.split(':').pop() === name)
      .sort(
        ([a], [b]) =>
          Number(!a.startsWith('Composite:')) -
          Number(!b.startsWith('Composite:')),
      );
    if (matches.length) return matches[0][1];
  }
  return null;
}
const clean = (raw: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(raw).filter(
      ([k]) => k !== 'SourceFile' && !k.startsWith('System:'),
    ),
  );
const parent = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stem = (path: string) => path.replace(/\.[^.]+$/, '');
export function csvCell(v: unknown): string {
  let s = v == null ? '' : textValue(v);
  if (typeof v === 'string' && /^[\s]*[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function makeRow(
  raw: Record<string, unknown>,
  f: InputFile,
  mode: Mode,
  source: string,
  contributor: string,
  id: string,
): Row {
  const row: Row = {
    contributor_id: contributor,
    photo_id: id,
    source,
    file_name: mode === 'full' ? base(f.path) : null,
    file_bytes: f.file.size,
    status: 'warning',
    gallery_capture_time_utc: null,
    sidecar_count: 0,
  };
  for (const [key, tags] of Object.entries(FIELDS)) {
    const v = getTag(raw, tags);
    row[key] =
      v == null
        ? null
        : NUMBERS.has(key)
          ? Number.isFinite(Number(v))
            ? Number(v)
            : null
          : typeof v === 'object'
            ? JSON.stringify(v)
            : textValue(v);
  }
  if (String(row.mime_type || '').startsWith('text/')) row.status = 'error';
  else if (row.capture_time_original || row.latitude != null) row.status = 'ok';
  if (mode === 'limited')
    for (const key of ['latitude', 'longitude', 'altitude_m', 'lens'])
      row[key] = null;
  return row;
}
export async function readMetadata(file: File): Promise<Record<string, unknown>> {
  const raw = await readFileMetadata(file);
  return clean(raw);
}
export async function createDataset(
  files: InputFile[],
  mode: Mode,
  source: string,
  progress: (p: ProgressUpdate) => void,
  sqliteLocate = (name: string) => runtimeAsset(`runtime/${name}`),
): Promise<Result> {
  const media = files.filter(isMedia),
    sidecarFiles = files.filter(isSidecar);
  if (!media.length)
    throw new Error(
      'No supported photos or videos found. Choose photos, an unzipped export folder, or Google Takeout ZIP files.',
    );
  const contributor = crypto.randomUUID();
  const mediaIds = new Map(media.map((f) => [f.path, crypto.randomUUID()]));
  const byName = new Map<string, InputFile[]>(),
    byStem = new Map<string, InputFile[]>();
  for (const f of media) {
    byName.set(f.path, [...(byName.get(f.path) || []), f]);
    const k = stem(f.path);
    byStem.set(k, [...(byStem.get(k) || []), f]);
  }
  type Sidecar = {
    sidecar_id: string;
    file_name: string | null;
    kind: string;
    status: string;
    candidate_photo_ids: string[];
    metadata: Record<string, unknown>;
    error: string | null;
  };
  const sidecars: Sidecar[] = [],
    matched = new Map<string, Sidecar[]>();
  let bytes = 0;
  const account = (obj: unknown) => {
    bytes += JSON.stringify(obj).length * 2;
    if (bytes > 400 * 1024 * 1024)
      throw new Error(
        'This export contains too much metadata for one browser download. Choose smaller folders and run them separately.',
      );
  };
  const total = media.length + sidecarFiles.length;
  let completed = 0;
  progress({ phase: 'Reading file headers…', completed, total });
  for (const f of sidecarFiles) {
      const sidecar: Sidecar = {
        sidecar_id: crypto.randomUUID(),
        file_name: mode === 'full' ? base(f.path) : null,
        kind: extension(f.path),
        status: 'unmatched',
        candidate_photo_ids: [],
        metadata: {},
        error: null,
      };
      let data: Record<string, unknown> = {};
      let candidates: InputFile[] = [];
      try {
        if (f.file.size > 10 * 1024 * 1024)
          throw new Error('Sidecar exceeds the 10 MB limit');
        if (extension(f.path) === 'json') {
          data = JSON.parse((await f.file.text()).replace(/^\uFEFF/, ''));
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new Error('Sidecar must be a JSON object');
          candidates =
            byName.get(f.path.slice(0, -5)) ||
            byName.get(f.path.replace(/\.supplemental-metadata\.json$/, '')) ||
            [];
          if (!candidates.length && typeof data.title === 'string')
            candidates = byName.get(parent(f.path) + data.title) || [];
        } else {
          data = await readMetadata(f.file);
          candidates =
            byName.get(stem(f.path)) || byStem.get(stem(f.path)) || [];
        }
        sidecar.candidate_photo_ids = candidates.map((c) =>
          mediaIds.get(c.path)!,
        );
        sidecar.status =
          candidates.length === 1
            ? 'matched'
            : candidates.length
              ? 'ambiguous'
              : 'unmatched';
        sidecar.metadata = data;
        if (candidates.length === 1)
          matched.set(candidates[0].path, [
            ...(matched.get(candidates[0].path) || []),
            sidecar,
          ]);
      } catch (error) {
        sidecar.status = 'error';
        sidecar.error =
          error instanceof Error ? error.message : 'Could not read sidecar';
      }
      // Retain raw sidecars only internally until date normalization, then strip in limited output.
      account(sidecar);
      sidecars.push(sidecar);
      progress({
        phase: 'Reading supplementary metadata…',
        completed: ++completed,
        total,
      });
      if (completed % 8 === 0) await yieldThread();
    }
    const SQL = await initSqlJs({ locateFile: sqliteLocate });
    const db = new SQL.Database();
    try {
      db.run(
        'CREATE TABLE photos (' +
          COLUMNS.map((c) => `"${c}" ${NUMBERS.has(c) ? 'REAL' : 'TEXT'}`).join(
            ',',
          ) +
          ', metadata_json TEXT, sidecar_ids_json TEXT)',
      );
      db.run(
        'CREATE TABLE sidecars (sidecar_id TEXT PRIMARY KEY, status TEXT, candidate_photo_ids_json TEXT, metadata_json TEXT)',
      );
      const insert = db.prepare(
        'INSERT INTO photos VALUES (' +
          Array(COLUMNS.length + 2)
            .fill('?')
            .join(',') +
          ')',
      );
      const rows: Row[] = [],
        lines: string[] = [];
      const missing: Record<string, number> = {},
        statuses: Record<string, number> = {};
      for (const f of media) {
        let raw: Record<string, unknown> = {};
        let failed = false;
        try {
          raw = await readMetadata(f.file);
        } catch {
          failed = true;
        }
        const row = makeRow(
          raw,
          f,
          mode,
          source,
          contributor,
          mediaIds.get(f.path)!,
        );
        if (failed) row.status = 'error';
        const attachments = matched.get(f.path) || [];
        row.sidecar_count = attachments.length;
        const times = new Set<string>();
        for (const s of attachments) {
          const value = (
            s.metadata.photoTakenTime as { timestamp?: unknown } | undefined
          )?.timestamp;
          if (value != null && Number.isFinite(Number(value))) {
            const date = new Date(Number(value) * 1000);
            if (Number.isFinite(date.getTime())) times.add(date.toISOString());
          }
        }
        if (times.size === 1)
          row.gallery_capture_time_utc = Array.from(times)[0];
        const metadata = mode === 'full' ? raw : {};
        const sidecarIds = attachments.map((s) => s.sidecar_id);
        const record = { ...row, metadata, sidecar_ids: sidecarIds };
        account(record);
        lines.push(JSON.stringify(record));
        insert.run([
          ...COLUMNS.map((k) => row[k] ?? null),
          JSON.stringify(metadata),
          JSON.stringify(sidecarIds),
        ]);
        statuses[String(row.status)] = (statuses[String(row.status)] || 0) + 1;
        for (const key of Object.keys(FIELDS))
          if (row[key] == null) missing[key] = (missing[key] || 0) + 1;
        rows.push(row);
        progress({
          phase: 'Extracting photo metadata…',
          completed: ++completed,
          total,
        });
        if (completed % 8 === 0) await yieldThread();
      }
      insert.free();
      const exportedSidecars = sidecars.map((s) => ({
        ...s,
        metadata: mode === 'full' ? s.metadata : {},
      }));
      const sideInsert = db.prepare('INSERT INTO sidecars VALUES (?,?,?,?)');
      for (const s of exportedSidecars)
        sideInsert.run([
          s.sidecar_id,
          s.status,
          JSON.stringify(s.candidate_photo_ids),
          JSON.stringify(s),
        ]);
      sideInsert.free();
      db.run(
        'CREATE INDEX photos_camera_model ON photos(camera_model); CREATE INDEX photos_capture_time ON photos(capture_time_original); PRAGMA optimize;',
      );
      const sidecarCounts: Record<string, number> = {};
      for (const s of sidecars)
        sidecarCounts[s.status] = (sidecarCounts[s.status] || 0) + 1;
      const manifest = {
        schema_version: 1,
        contributor_id: contributor,
        source,
        mode,
        created_utc: new Date().toISOString(),
        extractor: 'EXIF IFDs (DateTimeOriginal + GPS tags 1-6)',
        media_files: media.length,
        sidecar_files: sidecars.length,
        ignored_files: files.length - media.length - sidecars.length,
        status_counts: statuses,
        sidecar_status_counts: sidecarCounts,
        missing_or_omitted_fields: missing,
        record_unit:
          'one exported media file; repeated copies and Live Photo components are retained',
        deduplication: false,
        library_completeness_verified: false,
        originals_uploaded: false,
      };
      db.run('CREATE TABLE collection (manifest_json TEXT)');
      db.run('INSERT INTO collection VALUES (?)', [JSON.stringify(manifest)]);
      if (db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0] !== 'ok')
        throw new Error('The dataset could not be verified. Please try again.');
      progress({ phase: 'Packaging your dataset…', completed: total, total });
      const csv =
        '\uFEFF' +
        COLUMNS.join(',') +
        '\r\n' +
        rows
          .map((row) => COLUMNS.map((c) => csvCell(row[c])).join(','))
          .join('\r\n');
      const archive = zipSync(
        {
          'photos.sqlite': db.export(),
          'photos.csv': strToU8(csv),
          'metadata.jsonl': strToU8(lines.join('\n') + '\n'),
          'sidecars.jsonl': strToU8(
            exportedSidecars.map((s) => JSON.stringify(s)).join('\n'),
          ),
          'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
          'README.txt': strToU8(README),
          'queries.sql': strToU8(QUERIES),
        },
        { level: 6 },
      );
      return { archive, rows: rows.slice(0, 50), manifest };
    } finally {
      db.close();
    }
}
export const QUERIES = `-- Count files by camera (repeated export copies are included).
SELECT camera_model, COUNT(*) AS files FROM photos GROUP BY camera_model ORDER BY files DESC;
-- Review processing status.
SELECT status, COUNT(*) FROM photos GROUP BY status;
-- GPS-tagged files in full mode.
SELECT photo_id, latitude, longitude FROM photos WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
-- Explore arbitrary metadata tags with SQLite JSON support.
SELECT p.photo_id, j.key AS tag, j.value FROM photos p, json_each(p.metadata_json) j;
`;
export const README = `PHOTO METADATA DATASET

photos.sqlite: SQLite database with photos, sidecars and collection tables.
photos.csv: common columns, one row per exported media file. Spreadsheet formula-like strings are prefixed with an apostrophe; SQLite and JSON preserve the original text.
metadata.jsonl: one JSON object per file, including all readable tags in full mode.
sidecars.jsonl: supplementary Google JSON and Apple XMP, with match status and candidate photo IDs. Unmatched and ambiguous sidecars are retained without an invented match.
manifest.json: settings, counts, ignored files, errors and missing/omitted fields.
queries.sql: example queries.

Full mode includes readable EXIF, IPTC and XMP from file headers, plus sidecars. It can contain GPS, names, captions, account links, device serials and other personal information. Not anonymous. Binary payloads and thumbnails are not extracted. SourceFile and filesystem tags are removed from raw media metadata. Arbitrary sidecar text can still contain paths. Only the first 2 MB of each file is read. No full-image decode.
Limited mode retains only common camera, date, dimension and exposure fields. GPS, filenames, lens text and all arbitrary raw metadata/sidecar payloads are omitted. This is deliberately NOT a full EXIF export. Dates and camera models can still identify people.

capture_time_original is DateTimeOriginal with OffsetTimeOriginal appended when present, in the file's own format. Do not assume UTC. gallery_capture_time_utc comes from a matching Google photoTakenTime Unix timestamp when all matched sidecars agree. Original times are never overwritten by gallery dates. Google-edited GPS, captions and Apple XMP remain in sidecars, not flattened photo columns.
GPS is decoded from the GPS IFD (tags 1-6) into decimal degrees and metres. status is ok when capture time or latitude is present, warning when the file opened but those are missing, and error only when the file could not be read. Missing GPS is not an error.
Exposure is seconds, focal length millimetres, altitude metres, coordinates decimal degrees. Null means missing or intentionally omitted. One gallery item can produce multiple files (Live Photos, RAW/JPEG pairs, album duplicates). No deduplication is performed. IDs are random per run. The source field is a user-supplied label, not per-file detection.

Sidecars match exact names, .supplemental-metadata.json names, or a unique Google title in the same folder. Apple XMP can match a unique same-stem media file. JSON/XMP over 10 MB are marked as errors. Unsupported extensions are counted as ignored. Coverage describes the selected export, not the original cloud library. All Takeout ZIP parts should be selected together (from Drive or disk), or unzipped into one folder tree. Export completeness and album membership are not reconstructed.

Some damaged or unsupported files have error rows. That does not mean the photo is damaged, and it does not mean GPS was stripped — files without capture time or GPS are warning, not error. Maker notes and tags outside the header slices may be omitted. No original media are included in this dataset or uploaded by this app.
`;
