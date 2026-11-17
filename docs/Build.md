# Compile / build

> Early development. Builds can fail or behave oddly. Prefer a clean clone.

## Option A — Dev run (fastest)

From the repo root:

```powershell
cd app
npm install
```

In a second terminal:

```powershell
cd desktop-win
dotnet restore
dotnet run
```

The Windows host starts the Node server (port **8092**) and opens WebView2 + libVLC.

You can also start the server alone for browser smoke tests (no native VLC):

```powershell
cd app
npm start
```

Then open `http://127.0.0.1:8092/` in a browser. Playback quality without the desktop shell is limited.

## Option B — Portable folder (local only)

Build a folder you can run on the same machine (or zip yourself). **Do not** upload that folder or the `.exe` to GitHub.

```powershell
cd desktop-win
powershell -ExecutionPolicy Bypass -File .\publish.ps1
```

Output (gitignored): `dist/Cipher/`

- Run `Cipher.exe` from that folder.
- Target PCs need the **.NET 8 Desktop Runtime** (x64) and WebView2.
- Node is bundled under `node\`.
- Empty templates land in `config\` (add your own playlists locally).

## After building

1. [Add a playlist](Playlists.md)
2. If something fails, see [Troubleshooting](Troubleshooting.md)

## What we do *not* publish

- No GitHub **Releases**
- No committed `dist/`, `*.exe`, `*.apk`, or installers
- No prebuilt downloads — only source
