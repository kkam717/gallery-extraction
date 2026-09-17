import {
  createDataset,
  createDatasetFromParsed,
  type InputFile,
  type Mode,
  type ParsedMediaFile,
  type ParsedSidecarFile,
} from './dataset';

self.onmessage = async (
  event: MessageEvent<{
    files?: InputFile[];
    parsedMedia?: ParsedMediaFile[];
    parsedSidecars?: ParsedSidecarFile[];
    mode: Mode;
    source: string;
  }>,
) => {
  try {
    const progress = (update: { phase: string; completed: number; total: number }) =>
      self.postMessage({ type: 'progress', ...update });
    const result = event.data.parsedMedia?.length
      ? await createDatasetFromParsed(
          event.data.parsedMedia,
          event.data.parsedSidecars ?? [],
          event.data.mode,
          event.data.source,
          progress,
        )
      : await createDataset(event.data.files ?? [], event.data.mode, event.data.source, progress);
    self.postMessage({ type: 'done', ...result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'Extraction failed. Reload the page and try again.',
    });
  }
};
