import { createDataset, type InputFile, type Mode } from './dataset';

self.onmessage = async (
  event: MessageEvent<{ files: InputFile[]; mode: Mode; source: string }>,
) => {
  try {
    const result = await createDataset(
      event.data.files,
      event.data.mode,
      event.data.source,
      (progress) => self.postMessage({ type: 'progress', ...progress }),
    );
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
