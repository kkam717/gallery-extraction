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
  isMedia,
  isSidecar,
  type InputFile,
  type Mode,
  type Row,
} from '@/lib/dataset';
import { isDriveConfigured, pickTakeoutZipsFromDrive } from '@/lib/drive';
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
  const zipInput = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const ingestId = useRef(0);
  const [files, setFiles] = useState<InputFile[]>([]);
  const [mode, setMode] = useState<Mode>('full');
  const [source, setSource] = useState('mixed');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [result, setResult] = useState<Completed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      media: files.filter(isMedia).length,
      sidecars: files.filter(isSidecar).length,
      ignored: files.filter((file) => !isMedia(file) && !isSidecar(file)).length,
    }),
    [files],
  );

  function selectFiles(selected: InputFile[]) {
    setFiles(selected);
    setError(null);
    setResult(null);
    setProgress(null);
  }

  async function ingestFiles(selected: InputFile[]) {
    const id = ++ingestId.current;
    const zips = selected.filter((item) => isZipFile(item.file));
    const rest = selected.filter((item) => !isZipFile(item.file));
    setError(null);
    setResult(null);
    if (!zips.length) {
      selectFiles(selected);
      return;
    }
    setProgress({
      phase: 'Reading Takeout ZIP files…',
      completed: 0,
      total: zips.length,
    });
    try {
      const unpacked = await filesFromTakeoutZips(
        zips.map((item) => item.file),
        setProgress,
      );
      if (id !== ingestId.current) return;
      setSource('google');
      selectFiles([...rest, ...unpacked]);
    } catch (caught) {
      if (id !== ingestId.current) return;
      setProgress(null);
      setError(
        caught instanceof Error
          ? caught.message
          : 'The Takeout ZIP files could not be read.',
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
      selectFiles([
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
      ]);
    } catch {
      setError('The sample photo could not be loaded. Try choosing your own files.');
    }
  }

  function extract() {
    if (!counts.media || progress) return;
    setError(null);
    setResult(null);
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
    nextWorker.postMessage({ files, mode, source });
  }

  function reset() {
    ingestId.current += 1;
    worker.current?.terminate();
    worker.current = null;
    setFiles([]);
    setResult(null);
    setProgress(null);
    setError(null);
    if (folderInput.current) folderInput.current.value = '';
    if (fileInput.current) fileInput.current.value = '';
    if (zipInput.current) zipInput.current.value = '';
  }

  async function loadDriveZips() {
    const id = ++ingestId.current;
    setError(null);
    setResult(null);
    setProgress({ phase: 'Opening Google Drive…', completed: 0, total: 1 });
    try {
      const zips = await pickTakeoutZipsFromDrive(setProgress);
      if (id !== ingestId.current) return;
      if (!zips.length) {
        setProgress(null);
        return;
      }
      await ingestFiles(zips.map((file) => ({ file, path: file.name })));
    } catch (caught) {
      if (id !== ingestId.current) return;
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
          <span>Processed on your computer</span>
        </div>
      </header>

      <main className="workspace">
        <div className="heading">
          <div>
            <div className="eyebrow">Gallery → Dataset</div>
            <h1>Your gallery, in data.</h1>
            <p>
              Extract EXIF and sidecar metadata from photos, an Apple or Google
              export folder, or Google Takeout ZIP files. Nothing is uploaded.
            </p>
          </div>
          <div className="steps" aria-label="Three-step process">
            <span className={!progress && !result ? 'active' : ''}>
              <b>1</b> Select files
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
                  {result ? 'Your dataset is ready' : 'Add photos or an export'}
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
                    onChange={(event) =>
                      void ingestFiles(folderFiles(event.target.files))
                    }
                  />
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    accept="image/*,video/*,.heic,.heif,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.json,.xmp"
                    hidden
                    onChange={(event) =>
                      void ingestFiles(folderFiles(event.target.files))
                    }
                  />
                  <input
                    ref={zipInput}
                    type="file"
                    multiple
                    accept=".zip,application/zip,application/x-zip-compressed"
                    hidden
                    onChange={(event) =>
                      void ingestFiles(folderFiles(event.target.files))
                    }
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
                    <FolderUp className="upload-icon" size={64} />
                    <h3>
                      {files.length
                        ? `${files.length.toLocaleString()} files selected`
                        : 'Drop photos, an unzipped export, or Takeout ZIP files'}
                    </h3>
                    <p>
                      {files.length
                        ? `${counts.media.toLocaleString()} media · ${counts.sidecars.toLocaleString()} sidecars · ${counts.ignored.toLocaleString()} ignored`
                        : 'Google Takeout can stay zipped. Keep JSON or XMP sidecars next to photos if you already unzipped. Only headers are read.'}
                    </p>
                    <div className="chooser-row">
                      <button
                        className="primary"
                        onClick={() => folderInput.current?.click()}
                        disabled={!!progress}
                        type="button"
                      >
                        Choose folder <ArrowRight size={17} />
                      </button>
                      <button
                        className="secondary"
                        onClick={() => fileInput.current?.click()}
                        disabled={!!progress}
                        type="button"
                      >
                        <Images size={16} /> Choose photos
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
                        onClick={() => {
                          if (isDriveConfigured()) void loadDriveZips();
                          else zipInput.current?.click();
                        }}
                        disabled={!!progress}
                        type="button"
                        title={
                          isDriveConfigured()
                            ? 'Download Takeout ZIP files from your Google Drive into this browser'
                            : 'Select Takeout ZIP files you downloaded from Google Drive'
                        }
                      >
                        <Cloud size={16} /> From Google Drive
                      </button>
                    </div>
                    <span className="subtle">
                      Photos stay in this browser. Drive ZIPs are downloaded here, not to our servers.
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
                        Keep this tab open. Only file headers are read, so a
                        full library can run in this tab.
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
                No installations. No photo uploads.
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
              <details>
                <summary>How do I export my photos?</summary>
                <p>
                  <strong>Google:</strong> export Google Photos through Takeout
                  and save the archives to Drive. Then use{' '}
                  <strong>From Google Drive</strong> or{' '}
                  <strong>Takeout ZIP(s)</strong> and select every{' '}
                  <code>takeout-*.zip</code> part. You can still unzip locally
                  and choose the folder. Keep the JSON sidecar files.
                </p>
                <p>
                  <strong>Apple:</strong> in Photos on Mac, select photos → File
                  → Export → Export Unmodified Original. Enable Export IPTC as
                  XMP.
                </p>
                <p>
                  You can also skip the export and choose individual photos if
                  you only need EXIF from a few files.
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
          <span>Built for Apple Photos & Google Takeout exports</span>
          <span>Local extraction · No account connection</span>
        </footer>
      </main>
    </>
  );
}
