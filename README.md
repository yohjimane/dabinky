# dabinky

A custom browser-based video editor built on [Remotion](https://remotion.dev) and [Remotion Player](https://www.remotion.dev/player). Drop in video clips, arrange them on a multi-track timeline, add captions, and render to MP4.

## Prerequisites

- **Node.js 18+** and **npm** (anything newer is fine)
- **ffmpeg** (optional; only needed to render videos locally — `brew install ffmpeg` on macOS)

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

The working file `src/data/composition.json` is gitignored so each person has their own. To share a specific project, copy the JSON file directly (or commit it under a different name).

## Built on

- [Remotion](https://remotion.dev) — React-based video compositing.
- [Remotion Player](https://www.remotion.dev/player) — in-browser preview.
- [Vite](https://vitejs.dev) — editor dev server.

Remotion may require a company license for some uses — see the [Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
