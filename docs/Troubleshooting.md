# Troubleshooting

## Logs

| Log | Typical location |
| --- | --- |
| Host + Node tee | Portable: `<exe>\data\host.log` |
| Structured UI/server events | Portable: `<exe>\data\player-debug.log` |
| Dev / LocalAppData | `%LocalAppData%\Cipher\` (WebView2 profile; data often next to the exe for portable) |

In the app: Settings → enable **debug overlay**, or press **Ctrl+Shift+D**.

Useful tags in `player-debug.log`: `vlc.open`, `vlc.state`, `guide.preview`, `playlist.save`, `ui.route`, `ui.error`.

HTTP helpers (local server only):

- `GET /api/debug/info`
- `GET /api/debug/tail?n=100`

## Common issues

### App won’t start / “server not ready”

- Port **8092** already in use — close other Cipher/Node instances.
- Missing **.NET 8 Desktop Runtime** (x64).
- Check `host.log` for Node errors (`npm install` missing under a broken pack).

### Black screen / no video

- Confirm you are on the **desktop** shell (`Cipher.exe` / `dotnet run`), not a plain browser tab, if you expect libVLC.
- Provider stream dead — try another channel or Refresh playlist.
- Turn on debug overlay and look for `vlc.open` / `error`.

### UI lag

- Disable **Auto-play preview** in Settings.
- Shorten guide past/future hours.
- Close other heavy apps; Cipher runs WebView2 + Node + VLC together.

### Playlist / login fails

- Check URL, username/password, or MAG MAC.
- Portal down or geo-blocked — Cipher can’t fix provider outages.
- After editing `config/playlists.json` by hand, restart the app.

### “Where is the download?”

There isn’t one. Clone the repo and [build from source](Build.md). No `.exe` / `.apk` is published on GitHub.

## Still stuck?

Open a GitHub issue with:

- Windows version
- How you ran it (`dotnet run` vs portable)
- Relevant lines from `host.log` / `player-debug.log` (**redact** playlist URLs, passwords, and MACs)
