'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  ArrowRight,
  CheckCircle2,
  Database,
  Download,
  FileCheck2,
  FileJson,
  FolderUp,
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

type WorkerProgress = { phase: string; completed: number; total: number };
type Completed = {
  archive: Uint8Array;
  rows: Row[];
  manifest: Record<string, unknown>;
};
type WebkitFile = File & { webkitRelativePath?: string };
type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => Promise<Record<string, string>>;
    },
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};

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

export default function Home() {
  const input = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const [files, setFiles] = useState<InputFile[]>([]);
  const [mode, setMode] = useState<Mode>('full');
  const [source, setSource] = useState('mixed');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [result, setResult] = useState<Completed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => worker.current?.terminate(), []);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'configure_photo_dataset',
          title: 'Configure photo dataset',
          description: 'Set the visible export source and metadata privacy mode before the user selects a local folder.',
          inputSchema: {
            type: 'object',
            properties: {
              source: { type: 'string', enum: ['google', 'apple', 'mixed'] },
              mode: { type: 'string', enum: ['full', 'limited'] },
            },
            required: ['source', 'mode'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          async execute(inputValue) {
            const value = inputValue as { source?: string; mode?: string };
            if (!['google', 'apple', 'mixed'].includes(value.source ?? '') || !['full', 'limited'].includes(value.mode ?? '')) {
              throw new Error('source and mode must use one of the listed values');
            }
            setSource(value.source!);
            setMode(value.mode as Mode);
            return { source: value.source!, mode: value.mode! };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const counts = useMemo(
    () => ({
      media: files.filter(isMedia).length,
      sidecars: files.filter(isSidecar).length,
      ignored: files.filter((file) => !isMedia(file) && !isSidecar(file))
        .length,
    }),
    [files],
  );

  function selectFiles(selected: InputFile[]) {
    setFiles(selected);
    setError(null);
    setResult(null);
    setProgress(null);
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
      new URL('../lib/extract.worker.ts', import.meta.url),
      {
        type: 'module',
      },
    );
    worker.current = nextWorker;
    nextWorker.onmessage = (event) => {
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
        'The metadata reader stopped unexpectedly. Reload the page and try a smaller folder.',
      );
      setProgress(null);
      nextWorker.terminate();
      worker.current = null;
    };
    nextWorker.postMessage({ files, mode, source });
  }

  function reset() {
    worker.current?.terminate();
    worker.current = null;
    setFiles([]);
    setResult(null);
    setProgress(null);
    setError(null);
    if (input.current) input.current.value = '';
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
            <p>Extract photo metadata from an Apple or Google export folder.</p>
          </div>
          <div className="steps" aria-label="Three-step process">
            <span className={!progress && !result ? 'active' : ''}>
              <b>1</b> Select folder
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
                  {result ? 'Your dataset is ready' : 'Add your photo export'}
                </h2>
                <span className="tag">APPLE + GOOGLE</span>
              </div>

              {!result ? (
                <>
                  <input
                    ref={input}
                    type="file"
                    multiple
                    {...({
                      webkitdirectory: '',
                      directory: '',
                    } as React.InputHTMLAttributes<HTMLInputElement>)}
                    hidden
                    onChange={(event) =>
                      selectFiles(folderFiles(event.target.files))
                    }
                  />
                  <div
                    className={`dropzone ${dragging ? 'drag' : ''}`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      if (event.dataTransfer.files.length)
                        selectFiles(folderFiles(event.dataTransfer.files));
                    }}
                  >
                    <FolderUp className="upload-icon" size={64} />
                    <h3>
                      {files.length
                        ? `${files.length.toLocaleString()} files selected`
                        : 'Choose your exported folder'}
                    </h3>
                    <p>
                      {files.length
                        ? `${counts.media.toLocaleString()} media · ${counts.sidecars.toLocaleString()} sidecars · ${counts.ignored.toLocaleString()} ignored`
                        : 'Include original photos and the accompanying JSON or XMP files. Unzip your export first.'}
                    </p>
                    <button
                      className="primary"
                      onClick={() => input.current?.click()}
                      disabled={!!progress}
                    >
                      {files.length
                        ? 'Choose a different folder'
                        : 'Choose folder'}{' '}
                      <ArrowRight size={17} />
                    </button>
                    <span className="subtle">
                      Your photos never leave this browser.
                    </span>
                  </div>

                  <div className="field-title">Export source</div>
                  <RadioGroup
                    className="source-options"
                    value={source}
                    onValueChange={(value) => setSource(String(value))}
                    aria-label="Export source"
                  >
                    {[
                      ['google', 'Google Photos'],
                      ['apple', 'Apple Photos'],
                      ['mixed', 'Mixed / unsure'],
                    ].map(([value, label]) => (
                      <label
                        key={value}
                        htmlFor={`source-${value}`}
                        className={`source-option ${source === value ? 'selected' : ''}`}
                      >
                        <RadioGroupItem id={`source-${value}`} value={value} aria-label={label} />{' '}
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
                    {[
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
                    ].map(([value, title, description]) => (
                      <label
                        key={value}
                        htmlFor={`mode-${value}`}
                        className={`mode-card ${mode === value ? 'selected' : ''}`}
                      >
                        <RadioGroupItem id={`mode-${value}`} value={value} aria-label={title} />
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
                        Keep this tab open. Large galleries can take several
                        minutes.
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
                    <button className="secondary" onClick={reset}>
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
                  <p className="notice">
                    Previewing up to 50 rows. The ZIP contains the full dataset
                    and coverage report.
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
                >
                  <Download size={17} /> Download dataset ZIP
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!counts.media || !!progress}
                  onClick={extract}
                >
                  Extract metadata <ArrowRight size={17} />
                </button>
              )}
            </div>
          </section>

          <aside className="sidebar">
            <section className="panel panel-pad">
              <h2>One ZIP. Ready to explore.</h2>
              {[
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
              ].map(({ Icon, title, description }) => (
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
                  <strong>Google:</strong> export Google Photos through Takeout.
                  Unzip every part into the same folder tree and keep JSON
                  files.
                </p>
                <p>
                  <strong>Apple:</strong> in Photos on Mac, select photos → File
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
          <span>Built for Apple Photos & Google Takeout exports</span>
          <span>Local extraction · No account connection</span>
        </footer>
      </main>
    </>
  );
}
