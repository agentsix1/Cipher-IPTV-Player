# Getting started

Cipher is a **Windows desktop** IPTV client in **early development**. Expect bugs, missing polish, and UI changes.

## Before you start

1. Read the warning on the [main README](../README.md) — this is not ready for everyday use.
2. You will **build from source**. This project does not ship `.exe` / `.apk` files or GitHub Releases.
3. Only the **desktop** app is documented and intended for experimenters right now.
4. Read [`LICENSE`](../LICENSE): personal use and private modification only — **no** redistribution or publishing of originals or modified builds.

## Checklist

- [ ] Windows 10/11 **x64**
- [ ] [Node.js 18+](https://nodejs.org/) on `PATH`
- [ ] [.NET 8 SDK](https://dotnet.microsoft.com/download) (to compile)
- [ ] [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) x64 (to run)
- [ ] WebView2 Runtime (usually present on Windows 11)

Then:

1. [Install prerequisites](Install.md)
2. [Compile and run](Build.md)
3. [Add a playlist](Playlists.md)
4. Skim [Features](Features.md)

## UI note

The interface is **mid-update** (Cipher hub theme: Home, Guide, Movies/Shows). Layout, navigation, and focus behavior may change between commits. Screenshots in issues or chats may not match your build.
