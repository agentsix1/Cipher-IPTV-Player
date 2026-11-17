# Features (current)

> The **UI is mid-update**. Labels, spacing, and focus behavior may change. What works today may look different tomorrow.

Cipher is a desktop IPTV client with a Cipher-styled hub UI and native libVLC playback.

## Navigation

Top bar (overlay): **Home · TV Guide · Movies · Shows · Search · Settings**

- Keyboard / TV remote (D-pad) friendly in many places.
- **Back** / Backspace follows a hierarchy (e.g. detail → list → previous screen). Exact behavior is still being polished.

## Home

- **Continue Watching** hero when you have resume progress (live or VOD).
- **Recently watched** and **For You** style rows (when data is available).
- Highlight color is configurable in Settings.

## TV Guide

- Grid of channels × time with programme cells.
- Catch-up when the provider supports it (cells marked for archive).
- Bottom dock with details / optional preview.
- **Auto-play preview** defaults **off** (saves CPU/RAM). Turn it on in Settings if you want it.
- Channel manage: reorder, hide, rename, favorites (context menus / manage flows).

## Movies & Shows (VOD)

- Category rows / grids with paging arrows.
- Sticky hero with title, meta, play / resume, bookmark.
- Series: seasons / episodes when the provider returns them.
- Progress bars for in-progress titles when tracked.

## Search

- Search across live / VOD depending on catalog type and provider.
- Results open into the appropriate player or detail flow.

## Player

- Full-screen playback via **libVLC** in the desktop shell.
- Live channels, catch-up, and VOD.
- Volume, seek (where length is known), subtitles when tracks exist.
- Stream bytes come through the local **`/api/stream` proxy** (headers / cookies / connection rules).

## Settings (highlights)

- Playlists (add / edit / refresh / activate / delete)
- Guide window (past / future hours), preview autoplay
- Combine playlists (experimental)
- Hub highlight color
- Debug overlay (`Ctrl+Shift+D`)
- Config / layout backup import-export

## Performance notes

Weaker PCs: keep **guide auto-preview off**, use a shorter guide time window, and avoid leaving many huge VOD categories open if the UI feels heavy. See also [Troubleshooting](Troubleshooting.md).

## Not ready / incomplete

- Phone / Android app (not in the public repo yet)
- Pixel-perfect UI polish
- Guaranteed MAG/Xtream compatibility for every portal
- Official installers or Releases
