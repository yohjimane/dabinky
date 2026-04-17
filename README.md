# dabinky

A custom browser-based video editor built on [Remotion](https://remotion.dev) and [Remotion Player](https://www.remotion.dev/player). Drop in video clips, arrange them on a multi-track timeline, add captions, and render to MP4.

## Prerequisites

- **Node.js 18+** and **npm** (anything newer is fine)

ffmpeg is bundled via `ffmpeg-static`, so no separate install is needed for in-editor rendering or the packaged desktop app.

## Quick start

```bash
git clone git@github.com:yohjimane/dabinky.git
cd dabinky
npm install          # postinstall auto-creates src/data/composition.json from default
npm run editor       # opens the custom timeline editor at http://localhost:5180
```

That's it. The editor is empty on first launch — drag video files into the **Media pool** on the left (or click **+ Import**) to start.

## The three commands you need

| Command            | What it does                                                                           |
| ------------------ | -------------------------------------------------------------------------------------- |
| `npm run editor`   | Custom editor: media pool, timeline, drag handles, undo/redo, save. **Use this most.** |
| `npm run dev`      | Remotion Studio — lower-level preview with props panel. Reads the same project file.   |
| `npx remotion render` | Render the current project to an MP4 (output in `out/`).                            |

The editor and Studio share the same project state (`src/data/composition.json`), so edits in one are visible to the other after reload.

## Using the editor

- **Import media** — drop video files onto the media pool (left dock), or click **+ Import**. Supported: `.mp4 / .mov / .webm / .mkv / .m4v`.
- **Add clips** — drag a media-pool item onto a video track in the timeline, or onto a track group in the right sidebar.
- **Arrange** — drag clips to move; drag the edges to trim; click the **Blade** button (or press `B`) to split the selected clip at the playhead.
- **Captions** — add text segments in the right sidebar (under Text tracks) and drag them on the timeline. Edit text inline.
- **Scrub** — drag the red playhead triangle, or click/drag on the ruler. **Spacebar** plays/pauses.
- **Snapping** — clip/segment edges snap to other edges, the playhead, and timeline start (yellow guide line shows when active).
- **Tracks** — add or reorder video/text tracks from the right sidebar. Higher tracks render on top (z-order).
- **Save** — click **Save** in the top bar or press **⌘S** (yellow button indicates unsaved changes).
- **Undo/redo** — **⌘Z / ⌘⇧Z**.
- **Export / import** — click **⇣ Export** in the top bar to download the current project as a single `.dabinky` file (composition + every referenced video bundled into one ZIP). **⇡ Import** loads a `.dabinky` back. Use this to share a project with someone who doesn't have the source videos — everything they need is inside the bundle. Re-imports of the same media dedupe by SHA-256, so round-tripping the same file doesn't duplicate on disk.

## Rendering

```bash
npx remotion render MyComp out/my-video.mp4
```

Remotion reads from `src/data/composition.json` (whatever you've saved in the editor) and renders the full timeline.

## Where things live

| Path                                 | What                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `public/`                            | Your imported video files (gitignored). Everything the editor can use. |
| `src/data/composition.default.json`  | Empty project template (committed).                                  |
| `src/data/composition.json`          | Your current project (gitignored; auto-created from the default).    |
| `src/Composition.tsx`                | The Remotion composition — renders clips and captions.               |
| `editor/`                            | The custom editor React app (Vite).                                  |

## Sharing projects between machines

Use **⇣ Export** in the editor's top bar to produce a single `.dabinky` file — a ZIP containing the composition JSON plus every video clip it references. Send it to anyone; they click **⇡ Import** and the project loads with its media intact.

If you'd rather share only the composition (no video data), copy `src/data/composition.json` — it's gitignored so each person has their own, and you can commit it under a different name for versioned scenes.

## Desktop app (Electron)

The editor can also run as a standalone macOS app.

**Dev mode** — spawns an Electron window pointing at the dev server on port 5180:

```bash
npm run electron-dev
```

If `npm run editor` is already running on 5180, Electron reuses it. Otherwise Electron spawns its own Vite child.

**Build a `.dmg`** — produces an installable macOS bundle (Apple Silicon only for now):

```bash
npm run install-pw-browsers   # one-time, ~800 MB into ./pw-browsers/
npm run dist                  # outputs dist/Dabinky.dmg (~1 GB)
```

The `.dmg` bundles Electron, Vite, Playwright's Chromium + WebKit (for parallel rendering), and ffmpeg — users don't need any external installs. Project data (compositions, imported media, renders) lives in `~/Library/Application Support/Dabinky/`.

Local builds are **unsigned**, so first launch needs:

```bash
xattr -cr /Applications/Dabinky.app
codesign --force --deep --sign - /Applications/Dabinky.app
```

Signed + notarized builds are produced by `.github/workflows/build-dmg.yml` on tag push (`git tag v0.x.y && git push --tags`) and attached to a GitHub Release.

## Built on

- [Remotion](https://remotion.dev) — React-based video compositing.
- [Remotion Player](https://www.remotion.dev/player) — in-browser preview.
- [Vite](https://vitejs.dev) — editor dev server.
- [Playwright](https://playwright.dev) + [ffmpeg](https://ffmpeg.org) — parallel rendering pipeline.
- [Electron](https://www.electronjs.org) + [electron-builder](https://www.electron.build) — desktop packaging.

Remotion may require a company license for some uses — see the [Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
