# Photo Metadata Collector

A private, browser-based tool that extracts EXIF and gallery metadata from photos, Apple Photos exports, or Google Photos Takeout folders.

Photos are read locally with ExifTool compiled to WebAssembly. Source media is never uploaded.

The downloaded ZIP contains:

- `photos.sqlite` — SQLite database
- `photos.csv` — common metadata columns
- `metadata.jsonl` — per-file metadata records
- `sidecars.jsonl` — matched and unmatched Google JSON or Apple XMP sidecars
- `manifest.json` — coverage, mode and error counts
- `queries.sql` — starter queries

## Share it

This app is a static site. After this repository is on GitHub, the included GitHub Actions workflow publishes it to GitHub Pages.

The public URL is:

```text
https://<github-username>.github.io/<repo-name>/
```

If you publish it from [kkam717/gallery-extraction](https://github.com/kkam717/gallery-extraction), that URL is:

```text
https://kkam717.github.io/gallery-extraction/
```

Send that link. Recipients open it in a browser, choose photos or an unzipped export folder, extract metadata, and download a ZIP. They do not need to install anything.

The first GitHub Pages deploy enables the Pages site automatically. If the workflow asks for environment approval, approve **github-pages** in the repository settings.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Then open http://127.0.0.1:43123

## Verify

```bash
npm test
npm run build
```

## Privacy

Full mode can include GPS, names, captions, device identifiers and other private metadata. Limited mode omits GPS, filenames, lens text and arbitrary metadata payloads. Dates and camera models can still be identifying.

The app reports the selected export's contents. It cannot prove that an export contains every item in the original cloud library.
