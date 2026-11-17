# Install (prerequisites)

Cipher is **source-only**. Install these tools on the PC where you will compile and run it.

## Required

| Tool | Why |
| --- | --- |
| [Node.js 18+](https://nodejs.org/) (LTS is fine) | Local server + web UI (`app/`) |
| [.NET 8 SDK](https://dotnet.microsoft.com/download) | Compile the Windows host (`desktop-win/`) |
| [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) **x64** | Run a framework-dependent build |
| [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) | Hosts the HTML UI (usually already on Windows 11) |

## Verify

Open PowerShell:

```powershell
node -v
npm -v
dotnet --version
```

You want Node ≥ 18 and a .NET 8 SDK (`8.x`).

## Optional

- **Git** — clone the repo (`git clone …`) or download a ZIP of the source from GitHub.
- **GitHub Desktop** — fine for cloning; still no official Releases to install.

## Not required (for desktop)

- Android Studio / JDK — phone app is **not** part of the public tree right now.
- ffmpeg — Cipher does not remux; libVLC decodes.

## Next

→ [Compile / build](Build.md)
