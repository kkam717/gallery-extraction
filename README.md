# Photo Metadata Collector

A private, browser-based tool that extracts EXIF and gallery metadata from photos, Apple Photos exports, or Google Photos Takeout folders.

Photos are read locally in the browser. Only the metadata header of each file is parsed (not the full image, and not WebAssembly ExifTool). Source media is never uploaded.

**Share this link:** [https://kkam717.github.io/gallery-extraction/](https://kkam717.github.io/gallery-extraction/)

Source: [github.com/kkam717/gallery-extraction](https://github.com/kkam717/gallery-extraction)

Recipients open the link in a browser, choose photos or an unzipped export folder, extract metadata, and download a ZIP. They do not need to install anything. A few thousand photos is expected to work. Use **Try a sample** to confirm the tool works before sending your own files.

The downloaded ZIP contains:

- `photos.sqlite` — SQLite database
- `photos.csv` — common metadata columns
- `metadata.jsonl` — per-file metadata records
- `sidecars.jsonl` — matched and unmatched Google JSON or Apple XMP sidecars
- `manifest.json` — coverage, mode and error counts
- `queries.sql` — starter queries

## Publish updates

This repo deploys to GitHub Pages with `.github/workflows/deploy.yml` on every push to `main`.

If the first Actions run asks for environment approval, approve **github-pages** once in the repository settings.

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
