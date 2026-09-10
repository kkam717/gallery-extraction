# Photo Metadata Collector

A private, browser-based tool that converts an unzipped Apple Photos or Google Photos Takeout export into a queryable metadata dataset.

The app reads photos locally with ExifTool compiled to WebAssembly. It does not upload the source media. The downloaded ZIP contains:

- `photos.sqlite` — SQLite database
- `photos.csv` — common metadata columns
- `metadata.jsonl` — per-file metadata records
- `sidecars.jsonl` — matched and unmatched Google JSON or Apple XMP sidecars
- `manifest.json` — coverage, mode and error counts
- `queries.sql` — starter queries

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

## Verify

```bash
npm test
npm run build
```

Full mode can include GPS, names, captions, device identifiers and other private metadata. Limited mode omits GPS, filenames, lens text and arbitrary metadata payloads. Dates and camera models can still be identifying.

The app reports the selected export's contents; it cannot prove that an export contains every item in the original cloud library.
