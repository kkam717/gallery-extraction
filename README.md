# Photo Metadata Collector

A private tool that extracts EXIF and gallery metadata from an iPhone or Android camera roll, Apple Photos exports, or Google Photos Takeout folders.

Local photos and ZIP files are read in the browser. **From Google Drive** sends only the selected file IDs and a short-lived Google token to a Cloud Run extractor; the Takeout ZIPs are read from Drive there and are not downloaded to your computer. Only the metadata header of each file is parsed (not the full image). The extractor does not keep the archives after the dataset is built.

**Share this link:** [https://kkam717.github.io/gallery-extraction/](https://kkam717.github.io/gallery-extraction/)

Source: [github.com/kkam717/gallery-extraction](https://github.com/kkam717/gallery-extraction)

Recipients open the link on a phone or computer.

On **Android (Chrome)** use **Select all** in a folder: tap **Select all — DCIM folder**, choose Files (not Photos / Google Photos), then Internal storage → DCIM. Sliding one-by-one in Google Photos is capped at 100 items and often returns nothing. Cloud-only Google Photos that were never downloaded to the phone are not in DCIM; those still need Takeout.

On **iPhone (Safari)** tap **Add from camera roll**. Safari is not capped at 100, but there is no “select entire Camera Roll” control, so add from Recents and **Add more** if needed.

Extract metadata and download a dataset ZIP. Photos stay on the device; only EXIF headers are read.

Desktop users can still choose an unzipped export folder or Google Takeout ZIP files. **From Google Drive** processes those ZIPs in the cloud so the browser never downloads the archives. A few thousand photos is expected to work. Use **Try a sample** to confirm the tool works before sending your own files.

If Takeout split the export into several `takeout-*.zip` parts, select the **Takeout** folder in Drive, then select every ZIP inside it. The extractor unpacks media headers and sidecar JSON inside the archives.

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

The **From Google Drive** button needs a Google Cloud OAuth client, API key, and the Cloud Run extractor URL. Create the OAuth client in a Google Cloud project with the Google Picker API and Google Drive API enabled, then set:

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GOOGLE_API_KEY`
- `VITE_GOOGLE_APP_ID` (the project number)

Authorized JavaScript origins should include `https://kkam717.github.io` and `http://127.0.0.1:43123`. Restrict the API key to those HTTP referrers. Use the `drive.file` scope so the site only sees files the user picks. Deploy `Dockerfile` to Cloud Run in the same project (`npm run build:extract-api` is used by the image). Then set `VITE_EXTRACT_API_URL` to that service URL, for example `https://gallery-extract-xxxxx.a.run.app`. For GitHub Pages, store the same values as repository secrets with those names.

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
