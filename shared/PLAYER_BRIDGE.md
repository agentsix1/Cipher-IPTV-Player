# Native libVLC ↔ HTML bridge

Exposed on the page as `window.XsNative` (Android) or `window.XsNative` (Windows WebView2).

## Capability

| Method | Args | Returns |
| --- | --- | --- |
| `hasVlc()` | — | `true` when native VLC is available |
| `vlcOpen(url, optsJson)` | absolute proxy URL, JSON `{ start?, live? }` | void |
| `vlcPlay()` | — | void |
| `vlcPause()` | — | void |
| `vlcStop()` | — | void |
| `vlcSeek(seconds)` | number | void |
| `vlcGetTime()` | — | seconds (float) |
| `vlcGetLength()` | — | seconds (float), 0 if live/unknown |
| `vlcIsPlaying()` | — | boolean |
| `vlcSetVolume(level)` | 0..1 | void |
| `vlcGetVolume()` | — | 0..1 |
| `vlcGetSubtitleTracks()` | — | JSON string `[{id,name},…]` (SPU tracks; excludes disable) |
| `vlcGetSubtitleTrack()` | — | current SPU id (`-1` = none) |
| `vlcSetSubtitleTrack(id)` | int (`-1` = none) | void |
| `hostLog(level, msg)` | `info`/`warn`/`error`, string | void (Windows desktop → `host.log`) |
| `setImmersive(on)` | bool | void (phone) |
| `setLandscape(on)` | bool | void (phone) |
| `setFullscreen(on)` | bool | void (Windows: borderless window fullscreen; Escape exits) |
| `isFullscreen()` | — | bool (Windows desktop) |

Native fullscreen notifies the page:

```js
window.__onNativeFullscreen && window.__onNativeFullscreen(true|false);
```

## Events (native → JS)

Native calls into the page:

```js
window.__vlcOnState && window.__vlcOnState({
  state: 'opening'|'playing'|'paused'|'buffering'|'ended'|'error'|'stopped',
  time: 12.3,
  length: 3600,
  buffering: 0.5, // 0..1 optional
  error: ''
});
```

The HTML player chrome stays in control; `<video>` is hidden when VLC is active.
