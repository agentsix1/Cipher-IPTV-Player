# Add a playlist

Playlists are configured **in the app** (Settings → Playlists) or via local files next to a portable build. **Never commit real logins** — `config/playlists.json` is gitignored.

## In the app (recommended)

1. Open **Settings** (top nav).
2. Under **Playlists**, click **+ Add playlist**.
3. Choose a type and fill the fields:

| Type | What you enter |
| --- | --- |
| **Xtream Codes** | Server URL, username, password (optional stream format) |
| **M3U** | Playlist URL (`.m3u` / `.m3u8`) |
| **MAG** | Portal URL + MAC address |

4. Save. For the first playlist, Cipher activates it and loads channels / guide / VOD (can take a while).
5. Use **Refresh** on a playlist to reload channels, EPG, movies, and shows.
6. **Use** switches the active playlist when you have more than one.

Example shapes (placeholders only) live in [`config/playlists.example.json`](../config/playlists.example.json).

## Portable / file edit

Next to `Cipher.exe`:

| File | Purpose |
| --- | --- |
| `config/playlists.json` | Playlist definitions |
| `config/layout.ini` | Group order, renames, hidden channels, favorites |

Edit, then **restart** the app (or change a setting in-app so files reload).

Minimal empty playlist file:

```json
{
  "version": 1,
  "playlists": []
}
```

## Tips

- Prefer HTTPS when your provider supports it.
- MAG/Xtream portals vary a lot — broken streams are often provider-side, not Cipher.
- Extra XMLTV guides can be added per playlist in Settings.
- Export/import config from Settings → backup tools if you move PCs (still keep files private).

## Next

→ [Features](Features.md)
