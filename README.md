# Lectern

A PDF reader that reads aloud. Open a PDF, press play, and the page follows the voice: the sentence being spoken is lit in amber, and you can click any line on the page to start reading from there.

Everything runs on your own computer. Files are never uploaded, and the voices are the ones installed with Windows (or whatever system the app runs on).

## Install on Windows

Download from the [releases page](https://github.com/maddoxwolfe25/lectern/releases):

| File | What it is |
| --- | --- |
| `Lectern Setup x.y.z.exe` | Installer. Adds a Start menu entry and desktop shortcut, lets you right-click a PDF and choose **Open with → Lectern**, and **updates itself**: new versions download in the background and you are asked to restart. |
| `Lectern-x.y.z-portable.exe` | Single file, no install. Copy it anywhere (a USB stick works) and double-click. Does not update itself; replace the file with a newer one. |

Windows SmartScreen will warn that the publisher is unknown because the app is not code-signed. Click **More info → Run anyway**. Help → Check for updates… checks on demand.

## Publishing a new version

1. Bump `version` in `package.json` (for example `1.1.1`) and commit.
2. `npm run dist` builds the installer, the portable exe and `latest.yml` into `dist/`.
3. Create a GitHub release tagged `v1.1.1` and attach `dist/Lectern Setup 1.1.1.exe`, `dist/Lectern Setup 1.1.1.exe.blockmap`, `dist/latest.yml` and the portable exe. Installed copies pick the update up within a few hours, or immediately via Help → Check for updates.

The release must be a published release (not a draft or pre-release) in the public `maddoxwolfe25/lectern` repository for installed copies to see it.

## Using it

- **Open PDF** in the toolbar, drag a file onto the window, or `Ctrl+O`.
- **Play** (or `Space`) reads from the current page. Click any sentence on the page, or in the transcript, to read from there.
- **Skip buttons** or `Shift+←` / `Shift+→` move one sentence at a time.
- **Voice, Speed, Pitch** are in the Read aloud panel. *Follow the voice* keeps the page scrolled to the sentence being read. *Skip page numbers* drops footers like "Page 3 of 12".
- **Find** (`Ctrl+F`) searches the whole document; matches are tinted teal.
- **Pages** sidebar shows thumbnails. If the PDF has bookmarks, an **Outline** tab appears.
- Zoom with the toolbar, the preset list (Fit width, Fit page) or `Ctrl` + mouse wheel. `R` rotates.
- Your place in each document and your voice settings are remembered.

### Voices

The Voice list has two groups:

- **Natural voices (offline)**: neural voices from the open-source [Piper](https://github.com/rhasspy/piper) engine, bundled with the desktop app. Pick one and it downloads once (about 63 MB for medium quality, 115 MB for high) into Lectern's data folder, then runs entirely on your computer with no internet needed. They sound far less robotic than the Windows defaults. Speed changes instantly; pitch is not adjustable for these voices. File → Open voices folder shows where they live.
- **System voices**: whatever Windows provides (David, Zira, Mark). On Windows 11 you can add more under **Settings → Time & language → Speech → Manage voices**; they appear after restarting Lectern.

### Reading part of a document

- **Read selection**: select any text on the page with the mouse and press the "Read selection" button that pops up (or Space). Only that text is read; afterwards the document reading continues from where it was.
- **Read only highlighted text**: tick this in the Read aloud panel to play through just the passages you marked with the Highlight tool in Edit mode, skipping everything else.

### Merge PDFs and export Markdown

- **Merge PDFs** (the merge button next to Open, or on the start screen): add files with the file picker or by dropping them on the dialog, put them in order, and merge. The open document, including unsaved edits, is included first. Each source file becomes a bookmark in the result, which opens in Lectern ready to Save PDF.
- **Export as Markdown** (toolbar button next to Save): writes the document's text as a `.md` file. Headings are detected from font size, numbered and bulleted lists are kept, and repeated page headers, footers and page numbers are dropped. Tables and images are not converted.

## Editing (comment, mark up, fill and sign)

Press **Edit** in the toolbar (or `E`). A second row of tools appears:

| Tool | What it does |
| --- | --- |
| Select (`V`) | Click a mark to select it, drag to move, use the corner handle to resize, press Delete to remove. Double-click a text box to edit it; click a comment to open it. |
| Highlight (`H`), Underline (`U`), Strikethrough | Select text on the page with the mouse and the mark is applied. |
| Comment (`N`) | Click the page to drop a sticky note and type. Saved as a real PDF comment, so Adobe Reader and other apps show it. Comments already in the file are shown and can be edited or deleted. |
| Text (`T`) | Click to place a text box and type. Size and colour from the toolbar. |
| Draw (`D`) | Freehand pen. Width and colour from the toolbar. |
| Rectangle, Ellipse, Arrow | Drag to draw. |
| Sign | Draw your signature once (kept on this computer), then click to place it. Resize with the handle. |
| Eraser | Click any mark to remove it. |

- **Redact** (`X`): select words with the Redact text tool, drag a box with Redact area, or type a word or phrase in "Redact every" and press Mark all to black out every occurrence in the document. Marks show with a red dashed edge until you save. On save, each page that has redactions is re-rendered as an image with the boxes burned in, so the hidden words are removed from the file rather than covered up. Text outside the boxes is written back invisibly, so search and read-aloud still work on those pages. Check the marks before saving: redaction cannot be undone once the file is saved.
- **Bookmarks**: binder-style markers on the right edge of every page. Add one from the **Bookmarks** panel in the sidebar ("Add a bookmark for page N") or with the bookmark tool (`B`) by clicking a page. Give it a label and colour, and choose the page it jumps to. Clicking a marker on any page jumps there; the one for the page you are on is drawn wider. Reorder, rename or delete them from the Bookmarks panel. On save they are written into the PDF as clickable links with their own artwork and as entries in the PDF's bookmark list, so they show up in Adobe Reader's Bookmarks pane and other apps. Reopen the file in Lectern and they are still editable.
- **Links** already in a PDF (table of contents, web links) are clickable when Edit mode is off.
- **Forms**: if the PDF has fillable fields they appear as live inputs; type into them, tick boxes, pick options. Values are written into the form on save.
- **Pages**: in Edit mode, hover a thumbnail to rotate that page or remove it (removed pages can be restored until you save).
- **Undo / Redo**: `Ctrl+Z` / `Ctrl+Y`. Unsaved edits are kept per document on this computer, so closing and reopening a file does not lose them.
- **Save PDF** (`Ctrl+S`) writes a new PDF. Marks, drawings, text and signatures become part of the page; comments stay editable annotations; form values are stored in the fields. Print also includes your edits.

What it does not do: change the original text of a PDF (reflowing paragraphs), OCR scans, or merge files. Those are paid Acrobat features and out of scope here.

## Develop

```bash
npm install
npm start          # run the desktop app from source
npm run web        # serve the same UI as a web page on http://localhost:8124
```

`node scripts/make-icon.js` regenerates `icon.png` and `icon.ico`.

## Build the downloads

```bash
npm run dist
```

Output lands in `dist/`. The first build downloads Electron and the installer tooling, so it takes a few minutes.

## How it works

- Rendering, text extraction, thumbnails, search and bookmarks use [PDF.js](https://mozilla.github.io/pdf.js/) (vendored in `vendor/`).
- Each page gets an invisible text layer positioned over the canvas. Sentences are segmented from the extracted text (with abbreviation and heading heuristics) and mapped back to those text spans, which is how the amber highlight and click-to-read work.
- Speech uses the Web Speech API, one sentence per utterance, which avoids the engine's limits on long utterances and makes pause, skip and highlighting precise.
- The desktop shell (`main.js`, `preload.js`) serves the UI over a private `app://` scheme with context isolation and a sandboxed renderer. The page only gets a tiny bridge: open dialog, save dialog, and "a file was opened with Lectern".

Scanned PDFs that contain only images have no text to read. Run them through an OCR tool first.
