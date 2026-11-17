# Cipher

> ## ⚠️ EARLY DEVELOPMENT — NOT READY FOR USE
>
> **Cipher is an unfinished prototype.** Features break, the UI is mid-redesign, and there are **no official builds or releases**.
>
> - Do **not** treat this as a daily driver or a finished IPTV client.
> - Do **not** expect polished support, stability, or complete documentation of every edge case.
> - There are **no `.exe` / `.apk` downloads** and **no GitHub Releases**. If you want to try it, you must **build from source** yourself.
>
> Use at your own risk. Feedback from developers is welcome; end-user “it doesn’t work on my PC” support is not the focus yet.

> ## Player only — not an IPTV service
>
> **Cipher does not provide IPTV, live TV, movies, shows, or any streaming content.**
>
> It is software that can play streams **you** supply (for example via your own M3U, Xtream, or MAG credentials from a provider you already have). This repository includes **no playlists, no channels, no accounts, and no media**.
>
> You are responsible for using Cipher only with content and services you are legally allowed to access. The authors are not affiliated with any IPTV provider and do not sell, host, or redistribute streams.

---

**Cipher** is a Windows desktop **media player** for IPTV-style playlists: HTML UI + native **libVLC**, with a local Node proxy (no ffmpeg remux).

| | |
| --- | --- |
| **Status** | Early development |
| **Platform (public)** | Windows desktop only |
| **UI** | Mid-update (Cipher hub theme in progress) |
| **Distribution** | Source code only — build it yourself |

## Docs (wiki)

| Guide | What it covers |
| --- | --- |
| [Getting started](docs/Getting-Started.md) | What you need, clone, first run |
| [Install](docs/Install.md) | Prerequisites (Node, .NET, WebView2, Desktop Runtime) |
| [Compile / build](docs/Build.md) | Dev run + portable pack from source |
| [Add a playlist](docs/Playlists.md) | M3U, Xtream, MAG |
| [Features](docs/Features.md) | Home, Guide, Movies, Shows, Search, Settings, player |
| [Troubleshooting](docs/Troubleshooting.md) | Logs, common issues |

## Repository layout

```
├── app/            # Node server + web UI (required)
├── desktop-win/    # Windows host (WebView2 + LibVLCSharp)
├── config/         # Example playlist/layout templates only
├── docs/           # User & developer wiki
└── shared/         # Native bridge notes
```

The Android / phone shell exists in development but is **not published** in this repository for now.

## Quick start (developers)

1. Install [Node.js 18+](https://nodejs.org/), [.NET 8 SDK](https://dotnet.microsoft.com/download), and [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) (x64). WebView2 is usually already on Windows 11.
2. Clone this repo.
3. See **[docs/Build.md](docs/Build.md)** for `dotnet run` or a local portable pack.

Or jump to **[docs/Getting-Started.md](docs/Getting-Started.md)**.

## What this project is *not*

- **Not an IPTV service** — no streams, channels, VODs, or subscriptions are provided here.
- Not a source of playlists, credentials, or pirated content.
- Not a finished product or a clone of any commercial IPTV app.
- Not a place to download prebuilt installers.
- Not affiliated with any IPTV provider, network, or content owner.

## License

Cipher is **source-available, not open source**.

See [`LICENSE`](LICENSE):

- You **may** use and **modify** the code for **personal, private** use.
- You **may** open **pull requests** to this project (temporary forks used only to submit a PR are fine).
- You **may not** redistribute, publish, or share the original **or** any modified version for others to use (no mirrors, no “my Cipher fork” releases, no uploaded builds).
- You **may not** use it commercially.

**libVLC** and other dependencies keep their own licenses (e.g. GPL/LGPL). This project does not grant redistribution rights for Cipher itself.
