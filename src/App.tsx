import { useMemo, useRef, useState, type InputHTMLAttributes } from 'react';
import {
  Aperture,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Database,
  Download,
  FileArchive,
  FileCheck2,
  FileJson,
  FolderUp,
  Images,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Table2,
} from 'lucide-react';
import { Progress, ProgressLabel } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  type InputFile,
  type Mode,
  type Row,
} from '@/lib/dataset';
import { extractDriveZipsRemote, pickDriveTakeoutZips } from '@/lib/drive';
import {
  emptyLibrary,
  mergeLibraries,
  parseGalleryItems,
  type StagedLibrary,
} from '@/lib/gallery';
import { filesFromTakeoutZips, isZipFile } from '@/lib/takeout';

type WorkerProgress = { phase: string; completed: number; total: number };
type Completed = {
  archive: Uint8Array;
  rows: Row[];
  manifest: Record<string, unknown>;
};
type WebkitFile = File & { webkitRelativePath?: string };

const previewColumns = [
  ['file_name', 'File'],
  ['capture_time_original', 'Captured'],
  ['camera_model', 'Camera'],
  ['iso', 'ISO'],
] as const;

function folderFiles(list: FileList | null): InputFile[] {
  return Array.from(list ?? []).map((file: WebkitFile) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

function downloadArchive(archive: Uint8Array) {
  const blob = new Blob([archive as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `photo-metadata-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function App() {
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const ingestId = useRef(0);
  const ingestAbort = useRef<AbortController | null>(null);
  const seenGalleryKeys = useRef(new Set<string>());
  const [cloudRun, setCloudRun] = useState(false);
  const [library, setLibrary] = useState<StagedLibrary>(emptyLibrary);
  const [mode, setMode] = useState<Mode>('full');
  const [source, setSource] = useState('mixed');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [result, setResult] = useState<Completed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      media: library.media.length,
      sidecars: library.sidecars.length,
    }),
    [library],
  );

  function resetLibraryState() {
    seenGalleryKeys.current = new Set();
    setLibrary(emptyLibrary());
    setError(null);
    setResult(null);
    setProgress(null);
    setCloudRun(false);
  }

  async function ingestFiles(selected: InputFile[], append = true) {
    const id = ++ingestId.current;
    const zips = selected.filter((item) => isZipFile(item.file));
    const rest = selected.filter((item) => !isZipFile(item.file));
    setError(null);
    setResult(null);
    setCloudRun(false);
    if (!append) resetLibraryState();
    try {
      let incoming = rest;
      if (zips.length) {
        setProgress({
          phase: 'Reading Takeout ZIP files…',
          completed: 0,
          total: zips.length,
        });
        const unpacked = await filesFromTakeoutZips(
          zips.map((item) => item.file),
          setProgress,
        );
        if (id !== ingestId.current) return;
        setSource('google');
        incoming = [...rest, ...unpacked];
      }
      if (!incoming.length) {
        if (zips.length) {
          setProgress(null);
          setError('Those ZIP files did not contain supported photos or sidecar files.');
        }
        return;
      }
      const seen = new Set(seenGalleryKeys.current);
      const parsed = await parseGalleryItems(incoming, setProgress, seen);
      if (id !== ingestId.current) return;
      seenGalleryKeys.current = seen;
      setLibrary((current) => (append ? mergeLibraries(current, parsed.library) : parsed.library));
      setProgress(null);
      if (!parsed.added && parsed.skipped) {
        setError('Those items were already added, or they are not supported photos or videos.');
      }
    } catch (caught) {
      if (id !== ingestId.current) return;
      setProgress(null);
      setError(
        caught instanceof Error
          ? caught.message
          : 'The selected photos could not be read.',
      );
    }
  }

  async function loadSample() {
    try {
      const base = import.meta.env.BASE_URL.endsWith('/')
        ? import.meta.env.BASE_URL
        : `${import.meta.env.BASE_URL}/`;
      const [photoRes, sidecarRes] = await Promise.all([
        fetch(`${base}samples/sunset.jpg`),
        fetch(`${base}samples/sunset.jpg.supplemental-metadata.json`),
      ]);
      if (!photoRes.ok || !sidecarRes.ok) {
        throw new Error('The sample photo could not be loaded.');
      }
      const [photoBuf, sidecarText] = await Promise.all([
        photoRes.arrayBuffer(),
        sidecarRes.text(),
      ]);
      await ingestFiles(
        [
          {
            file: new File([photoBuf], 'sunset.jpg', { type: 'image/jpeg' }),
            path: 'sample/sunset.jpg',
          },
          {
            file: new File([sidecarText], 'sunset.jpg.supplemental-metadata.json', {
              type: 'application/json',
            }),
            path: 'sample/sunset.jpg.supplemental-metadata.json',
          },
        ],
        false,
      );
    } catch {
      setError('The sample photo could not be loaded. Try choosing your own files.');
    }
  }

  function extract() {
    if (!counts.media || progress) return;
    setError(null);
    setResult(null);
    setCloudRun(false);
    setProgress({
      phase: 'Starting…',
      completed: 0,
      total: counts.media + counts.sidecars,
    });
    const nextWorker = new Worker(
      new URL('./lib/extract.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.current = nextWorker;
    nextWorker.onmessage = (event: MessageEvent<{ type: string } & Completed & WorkerProgress & { message?: string }>) => {
      if (event.data.type === 'progress') {
        setProgress(event.data);
      } else if (event.data.type === 'done') {
        setResult({
          archive: event.data.archive,
          rows: event.data.rows,
          manifest: event.data.manifest,
        });
        setProgress(null);
        nextWorker.terminate();
        worker.current = null;
      } else {
        setError(event.data.message || 'The dataset could not be created.');
        setProgress(null);
        nextWorker.terminate();
        worker.current = null;
      }
    };
    nextWorker.onerror = () => {
      setError(
        'The metadata reader stopped unexpectedly. Reload the page and try again.',
      );
      setProgress(null);
      nextWorker.terminate();
      worker.current = null;
    };
    try {
      nextWorker.postMessage({
        parsedMedia: JSON.parse(JSON.stringify(library.media)) as StagedLibrary['media'],
        parsedSidecars: JSON.parse(
          JSON.stringify(library.sidecars),
        ) as StagedLibrary['sidecars'],
        mode,
        source,
      });
    } catch {
      setError('The selected photos could not be prepared for extraction.');
      setProgress(null);
      nextWorker.terminate();
      worker.current = null;
    }
  }

  function reset() {
    ingestId.current += 1;
    ingestAbort.current?.abort();
    ingestAbort.current = null;
    worker.current?.terminate();
    worker.current = null;
    seenGalleryKeys.current = new Set();
    setLibrary(emptyLibrary());
    setResult(null);
    setProgress(null);
    setError(null);
    setCloudRun(false);
    if (folderInput.current) folderInput.current.value = '';
    if (fileInput.current) fileInput.current.value = '';
    if (galleryInput.current) galleryInput.current.value = '';
    if (zipInput.current) zipInput.current.value = '';
  }

  async function loadDriveZips() {
    const id = ++ingestId.current;
    ingestAbort.current?.abort();
    const controller = new AbortController();
    ingestAbort.current = controller;
    seenGalleryKeys.current = new Set();
    setLibrary(emptyLibrary());
    setError(null);
    setResult(null);
    setCloudRun(true);
    setProgress({ phase: 'Opening Google Drive…', completed: 0, total: 1 });
    try {
      const picked = await pickDriveTakeoutZips(setProgress);
      if (id !== ingestId.current) return;
      if (!picked.files.length && !picked.folders.length) {
        setCloudRun(false);
        setProgress(null);
        return;
      }
      setSource('google');
      const extracted = await extractDriveZipsRemote(
        picked.token,
        { files: picked.files, folders: picked.folders },
        mode,
        'google',
        setProgress,
        controller.signal,
      );
      if (id !== ingestId.current) return;
      setResult(extracted);
      setProgress(null);
    } catch (caught) {
      if (id !== ingestId.current) return;
      if (controller.signal.aborted) return;
      setCloudRun(false);
      setProgress(null);
      setError(
        caught instanceof Error
          ? caught.message
          : 'Google Drive could not be opened.',
      );
    }
  }

  const percent = progress?.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;
  const statusCounts = (result?.manifest.status_counts ?? {}) as Record<
    string,
    number
  >;
  const errored = statusCounts.error ?? 0;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Aperture className="brand-icon" size={39} /> Photo Metadata
        </div>
        <div className="local">
          <ShieldCheck size={17} />
          <span>
            {cloudRun
              ? 'Drive files stay in Google Drive'
              : 'Processed on your computer'}
          </span>
        </div>
      </header>

      <main className="workspace">
        <div className="heading">
          <div>
            <div className="eyebrow">Gallery → Dataset</div>
            <h1>Your gallery, in data.</h1>
            <p>
              Extract EXIF from your iPhone or Android camera roll, or from an
              Apple or Google export. Photos stay on this device. Drive archives
              are read in the cloud, not downloaded here.
            </p>
          </div>
          <div className="steps" aria-label="Three-step process">
            <span className={!progress && !result ? 'active' : ''}>
              <b>1</b> Add gallery
            </span>
            <ArrowRight size={14} />
            <span className={progress ? 'active' : ''}>
              <b>2</b> Extract
            </span>
            <ArrowRight size={14} />
            <span className={result ? 'active' : ''}>
              <b>3</b> Download
            </span>
          </div>
        </div>

        <div className="grid-main">
          <section className="panel">
            <div className="panel-pad">
              <div className="panel-title">
                <h2>
                  {result ? 'Your dataset is ready' : 'Add your gallery'}
                </h2>
                <span className="tag">APPLE + GOOGLE</span>
              </div>

              {!result ? (
                <>
                  <input
                    ref={folderInput}
                    type="file"
                    multiple
                    {...({
                      webkitdirectory: '',
                      directory: '',
                    } as InputHTMLAttributes<HTMLInputElement>)}
                    hidden
                    onChange={(event) => {
                      const picked = folderFiles(event.target.files);
                      event.target.value = '';
                      void ingestFiles(picked);
                    }}
                  />
                  <input
                    ref={galleryInput}
                    type="file"
                    multiple
                    accept="image/*,video/*,.heic,.heif"
                    hidden
                    onChange={(event) => {
                      const picked = folderFiles(event.target.files);
                      event.target.value = '';
                      void ingestFiles(picked);
                    }}
                  />
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    accept="image/*,video/*,.heic,.heif,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.json,.xmp"
                    hidden
                    onChange={(event) => {
                      const picked = folderFiles(event.target.files);
                      event.target.value = '';
                      void ingestFiles(picked);
                    }}
                  />
                  <input
                    ref={zipInput}
                    type="file"
                    multiple
                    accept=".zip,application/zip,application/x-zip-compressed"
                    hidden
                    onChange={(event) => {
                      const picked = folderFiles(event.target.files);
                      event.target.value = '';
                      void ingestFiles(picked);
                    }}
                  />
                  <div
                    className={`dropzone ${dragging ? 'drag' : ''}`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      if (event.dataTransfer.files.length)
                        void ingestFiles(folderFiles(event.dataTransfer.files));
                    }}
                    onDragLeave={() => setDragging(false)}
                  >
                    <Smartphone className="upload-icon" size={64} />
                    <h3>
                      {counts.media
                        ? `${counts.media.toLocaleString()} photos and videos ready`
                        : 'Add your iPhone or Android camera roll'}
                    </h3>
                    <p>
                      {counts.media
                        ? `${counts.sidecars.toLocaleString()} sidecars matched so far. Add another batch, then extract EXIF.`
                        : 'Safari and Chrome open your Photo Library. Select as many as you can, then tap Add more until the whole gallery is in. Only EXIF headers are read — the photos stay on this phone.'}
                    </p>
                    <div className="chooser-row">
                      <button
                        className="primary"
                        onClick={() => galleryInput.current?.click()}
                        disabled={!!progress}
                        type="button"
                      >
                        <Smartphone size={16} />
                        {counts.media ? 'Add more from camera roll' : 'Add from camera roll'}
                        <ArrowRight size={17} />
                      </button>
                      <button
                        className="secondary"
                        onClick={() => folderInput.current?.click()}
                        disabled={!!progress}
                        type="button"
                      >
                        <FolderUp size={16} /> Export folder
                      </button>
                      <button
                        className="secondary"
                        onClick={() => fileInput.current?.click()}
                        disabled={!!progress}
                        type="button"
                      >
                        <Images size={16} /> Files / sidecars
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void loadSample()}
                        disabled={!!progress}
                        type="button"
                      >
                        Try a sample
                      </button>
                      <button
                        className="secondary"
                        onClick={() => zipInput.current?.click()}
                        disabled={!!progress}
                        type="button"
                      >
                        <FileArchive size={16} /> Takeout ZIP(s)
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void loadDriveZips()}
                        disabled={!!progress}
                        type="button"
                        title="Select the Takeout folder in Google Drive"
                      >
                        <Cloud size={16} /> From Google Drive
                      </button>
                    </div>
                    <span className="subtle">
                      iOS and Android cannot grant the whole library in one tap.
                      Keep adding batches. Desktop users can drop a folder or
                      Takeout ZIP instead.
                    </span>
                  </div>

                  <div className="field-title">Export source</div>
                  <RadioGroup
                    className="source-options"
                    value={source}
                    onValueChange={(value) => setSource(String(value))}
                    aria-label="Export source"
                  >
                    {(
                      [
                        ['google', 'Google Photos'],
                        ['apple', 'Apple Photos'],
                        ['mixed', 'Mixed / unsure'],
                      ] as const
                    ).map(([value, label]) => (
                      <label
                        key={value}
                        htmlFor={`source-${value}`}
                        className={`source-option ${source === value ? 'selected' : ''}`}
                      >
                        <RadioGroupItem
                          id={`source-${value}`}
                          value={value}
                          aria-label={label}
                        />{' '}
                        {label}
                      </label>
                    ))}
                  </RadioGroup>

                  <div className="field-title">Metadata to include</div>
                  <RadioGroup
                    value={mode}
                    onValueChange={(value) => setMode(value as Mode)}
                    aria-label="Metadata to include"
                  >
                    {(
                      [
                        [
                          'full',
                          'Full metadata',
                          'All readable EXIF and supplementary metadata, including locations and personal details.',
                        ],
                        [
                          'limited',
                          'Limited metadata',
                          'Camera settings, dates and dimensions. No GPS, filenames or free text.',
                        ],
                      ] as const
                    ).map(([value, title, description]) => (
                      <label
                        key={value}
                        htmlFor={`mode-${value}`}
                        className={`mode-card ${mode === value ? 'selected' : ''}`}
                      >
                        <RadioGroupItem
                          id={`mode-${value}`}
                          value={value}
                          aria-label={title}
                        />
                        <div>
                          <strong>{title}</strong>
                          <p>{description}</p>
                        </div>
                      </label>
                    ))}
                  </RadioGroup>

                  {progress && (
                    <div className="status-box" aria-live="polite">
                      <Progress value={percent}>
                        <ProgressLabel>{progress.phase}</ProgressLabel>
                        <span className="progress-value">{percent}%</span>
                      </Progress>
                      <p className="notice">
                        Keep this tab open. Only file headers are read.
                        {cloudRun
                          ? ' Drive archives are processed in the cloud.'
                          : ' A full local library can run in this tab.'}
                      </p>
                    </div>
                  )}
                  {error && (
                    <div className="error" role="alert">
                      {error}
                    </div>
                  )}
                </>
              ) : (
                <div className="results">
                  <div className="result-header">
                    <div className="complete">
                      <CheckCircle2 size={25} />
                      <strong>Extraction complete</strong>
                    </div>
                    <button className="secondary" onClick={reset} type="button">
                      <RotateCcw size={16} /> Start over
                    </button>
                  </div>
                  <div className="stats">
                    <div className="stat">
                      <b>
                        {Number(result.manifest.media_files).toLocaleString()}
                      </b>
                      <span>media records</span>
                    </div>
                    <div className="stat">
                      <b>
                        {Number(result.manifest.sidecar_files).toLocaleString()}
                      </b>
                      <span>sidecar files</span>
                    </div>
                    <div className="stat">
                      <b>{errored.toLocaleString()}</b>
                      <span>extraction errors</span>
                    </div>
                  </div>
                  {result.rows.length === 0 ? (
                    <p className="notice">
                      No preview rows are available. Download the ZIP to inspect
                      the full dataset.
                    </p>
                  ) : (
                    <>
                      <p className="notice">
                        Previewing up to 8 rows. The ZIP contains the full
                        dataset and coverage report.
                      </p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {previewColumns.map(([, label]) => (
                              <TableHead key={label}>{label}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.rows.slice(0, 8).map((row) => (
                            <TableRow key={String(row.photo_id)}>
                              {previewColumns.map(([key]) => (
                                <TableCell
                                  className={key === 'file_name' ? 'filename' : ''}
                                  key={key}
                                >
                                  {row[key] ?? '—'}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="actionbar">
              <span className="subtle">
                {cloudRun
                  ? 'Drive ZIPs are not downloaded to this computer.'
                  : 'Camera-roll photos stay on this device. Only EXIF is kept.'}
              </span>
              {result ? (
                <button
                  className="primary"
                  onClick={() => downloadArchive(result.archive)}
                  type="button"
                >
                  <Download size={17} /> Download dataset ZIP
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!counts.media || !!progress}
                  onClick={extract}
                  type="button"
                >
                  Extract metadata <ArrowRight size={17} />
                </button>
              )}
            </div>
          </section>

          <aside className="sidebar">
            <section className="panel panel-pad">
              <h2>One ZIP. Ready to explore.</h2>
              {(
                [
                  {
                    Icon: Database,
                    title: 'Queryable database',
                    description: 'SQLite, with one record per media file.',
                  },
                  {
                    Icon: Table2,
                    title: 'Spreadsheet-ready CSV',
                    description: 'Common fields in a familiar table.',
                  },
                  {
                    Icon: FileJson,
                    title: 'Complete metadata JSON',
                    description: 'Readable tags and matched sidecars.',
                  },
                  {
                    Icon: FileCheck2,
                    title: 'Coverage report',
                    description: 'Missing fields, errors and file counts.',
                  },
                ] as const
              ).map(({ Icon, title, description }) => (
                <div className="export-item" key={title}>
                  <Icon size={21} />
                  <div>
                    <strong>{title}</strong>
                    <p>{description}</p>
                  </div>
                </div>
              ))}
              <div className="privacy-note">
                <LockKeyhole size={17} />
                <span>
                  Only you choose what to share. Review your dataset before
                  sending it to someone else.
                </span>
              </div>
            </section>
            <section className="panel help">
              <details open>
                <summary>How do I add my whole camera roll?</summary>
                <p>
                  <strong>iPhone:</strong> open this page in Safari. Tap{' '}
                  <strong>Add from camera roll</strong>. Choose Recents, tap
                  Select, then tap or drag across photos (HEIC and Live Photos
                  included). iOS limits how many you can pick at once, so tap{' '}
                  <strong>Add more from camera roll</strong> and continue until
                  the count matches your library. Then tap{' '}
                  <strong>Extract metadata</strong>.
                </p>
                <p>
                  <strong>Android:</strong> open this page in Chrome. Tap{' '}
                  <strong>Add from camera roll</strong>, pick Gallery / Photos,
                  and use Select all if your phone shows it. If the picker
                  stops, tap Add more and continue. Videos and HEIC are
                  included.
                </p>
                <p>
                  The browser cannot open your library in the background.
                  Photos never leave this device; only EXIF headers are read.
                </p>
              </details>
              <details>
                <summary>How do I export from Google or Apple instead?</summary>
                <p>
                  <strong>Google:</strong> export Google Photos through Takeout
                  and save the archives to Drive. Then use{' '}
                  <strong>From Google Drive</strong>, open the{' '}
                  <strong>Takeout</strong> folder and select every{' '}
                  <code>takeout-*.zip</code> part (Shift-click the first and
                  last). You can still download the ZIPs and use{' '}
                  <strong>Takeout ZIP(s)</strong>, or unzip locally and choose
                  the folder. Keep the JSON sidecar files.
                </p>
                <p>
                  <strong>Apple (Mac):</strong> in Photos, select photos → File
                  → Export → Export Unmodified Original. Enable Export IPTC as
                  XMP.
                </p>
                <a
                  href="https://takeout.google.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Takeout ↗
                </a>
              </details>
            </section>
          </aside>
        </div>
        <footer className="footer">
          <span>Built for iPhone, Android, Apple Photos & Google Takeout</span>
          <span>
            {cloudRun
              ? 'Cloud Drive extraction · files stay in Drive'
              : 'Local extraction · files stay on this device'}
          </span>
        </footer>
      </main>
    </>
  );
}
