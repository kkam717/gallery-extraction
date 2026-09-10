# Photo Metadata Collector

A private, browser-based tool that extracts EXIF and gallery metadata from photos, Apple Photos exports, or Google Photos Takeout folders.

Photos are read locally in the browser. Only the metadata header of each file is parsed (not the full image, and not WebAssembly ExifTool). Source media is never uploaded.

**Share this link:** [https://kkam717.github.io/gallery-extraction/](https://kkam717.github.io/gallery-extraction/)

Source: [github.com/kkam717/gallery-extraction](https://github.com/kkam717/gallery-extraction)

Recipients open the link in a browser, choose photos, an unzipped export folder, or Google Takeout ZIP files. **From Google Drive** downloads those ZIPs into the browser; they are not uploaded to this site. Extract metadata and download a dataset ZIP. They do not need to install anything. A few thousand photos is expected to work. Use **Try a sample** to confirm the tool works before sending your own files.

If Takeout split the export into several `takeout-*.zip` parts, select every part. The browser unpacks media headers and sidecar JSON inside the archives.

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

## Google Drive (optional)

The **From Google Drive** button needs a Google Cloud OAuth client and API key. Create them in a Google Cloud project with the Google Picker API and Google Drive API enabled, then set:

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GOOGLE_API_KEY`
- `VITE_GOOGLE_APP_ID` (the project number)

Authorized JavaScript origins should include `https://kkam717.github.io` and `http://127.0.0.1:43123`. Restrict the API key to those HTTP referrers. Use the `drive.file` scope so the site only sees files the user picks. For GitHub Pages, store the same values as repository secrets with those names.

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
