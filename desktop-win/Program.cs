using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using LibVLCSharp.Shared;
using LibVLCSharp.WinForms;

namespace Cipher;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        HostLog.Init();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) =>
        {
            HostLog.Error("ui.threadException", e.Exception);
            try
            {
                MessageBox.Show(e.Exception.Message, "Cipher — unexpected error",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { /* ignore */ }
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            HostLog.Error("app.unhandled", e.ExceptionObject as Exception ?? new Exception(e.ExceptionObject?.ToString()));
        };
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            HostLog.Error("task.unobserved", e.Exception);
            e.SetObserved();
        };

        try
        {
            HostLog.Info("boot", "Core.Initialize (LibVLC)");
            Core.Initialize();
            HostLog.Info("boot", "Application.Run(MainForm)");
            Application.Run(new MainForm());
        }
        catch (Exception ex)
        {
            HostLog.Error("boot.fatal", ex);
            MessageBox.Show(ex.Message, "Cipher failed to start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            HostLog.Info("shutdown", "process exit");
            HostLog.Close();
        }
    }
}

/// <summary>
/// File logger under &lt;exe&gt;/data/ (portable) with one-time migrate from %LocalAppData%.
/// host.log = human-readable host + Node tee; also mirrors structured lines into player-debug.log.
/// </summary>
static class HostLog
{
    static readonly object Gate = new();
    static StreamWriter? _host;
    static string _dataDir = "";
    static string _configDir = "";
    static string _baseDir = "";

    public static string BaseDir => _baseDir;
    public static string DataDir => _dataDir;
    public static string ConfigDir => _configDir;
    public static string HostLogPath => Path.Combine(_dataDir, "host.log");
    public static string PlayerDebugPath => Path.Combine(_dataDir, "player-debug.log");

    public static void Init()
    {
        _baseDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        _dataDir = Path.Combine(_baseDir, "data");
        _configDir = Path.Combine(_baseDir, "config");
        Directory.CreateDirectory(_dataDir);
        Directory.CreateDirectory(_configDir);
        MigrateFromLocalAppDataIfNeeded();
        lock (Gate)
        {
            _host = new StreamWriter(new FileStream(HostLogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8)
            {
                AutoFlush = true,
            };
        }
        Info("host.init", $"baseDir={_baseDir}");
        Info("host.init", $"dataDir={_dataDir}");
        Info("host.init", $"configDir={_configDir}");
    }

    /// <summary>Copy legacy %LocalAppData%\TivimateVlc\data (or Cipher\data) into portable ./data once.</summary>
    static void MigrateFromLocalAppDataIfNeeded()
    {
        try
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var candidates = new[]
            {
                Path.Combine(local, "Cipher", "data"),
                Path.Combine(local, "TivimateVlc", "data"),
            };
            var marker = Path.Combine(_dataDir, ".migrated-from-localappdata");
            if (File.Exists(marker)) return;
            var hasDb = File.Exists(Path.Combine(_dataDir, "cipher.db"))
                || File.Exists(Path.Combine(_dataDir, "xfinity.db"));
            foreach (var legacy in candidates)
            {
                if (!Directory.Exists(legacy)) continue;
                var legacyDb = File.Exists(Path.Combine(legacy, "cipher.db"))
                    ? Path.Combine(legacy, "cipher.db")
                    : Path.Combine(legacy, "xfinity.db");
                if (!hasDb && File.Exists(legacyDb))
                {
                    foreach (var file in Directory.GetFiles(legacy))
                    {
                        var name = Path.GetFileName(file);
                        if (name.Equals("host.log", StringComparison.OrdinalIgnoreCase)) continue;
                        if (name.Equals("player-debug.log", StringComparison.OrdinalIgnoreCase)) continue;
                        File.Copy(file, Path.Combine(_dataDir, name), overwrite: false);
                    }
                }
                break;
            }
            File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
        }
        catch
        {
            /* best-effort */
        }
    }

    public static void Close()
    {
        lock (Gate)
        {
            try { _host?.Flush(); _host?.Dispose(); } catch { /* ignore */ }
            _host = null;
        }
    }

    public static void Info(string tag, string msg) => Write("info", tag, msg);
    public static void Warn(string tag, string msg) => Write("warn", tag, msg);
    public static void Error(string tag, string msg) => Write("error", tag, msg);

    public static void Error(string tag, Exception? ex)
    {
        var msg = ex == null ? "(null)" : $"{ex.GetType().Name}: {ex.Message}";
        Write("error", tag, msg, new Dictionary<string, object?>
        {
            ["stack"] = ex?.StackTrace,
        });
    }

    public static void Write(string level, string tag, string msg, object? data = null)
    {
        var ts = DateTime.UtcNow.ToString("o");
        var human = $"[{ts}] [{level.ToUpperInvariant()}] {tag}{(string.IsNullOrEmpty(msg) ? "" : $": {msg}")}";
        lock (Gate)
        {
            try { _host?.WriteLine(human); } catch { /* ignore */ }
            try
            {
                // Open/close per line so Node can rotate player-debug.log freely.
                var row = new Dictionary<string, object?>
                {
                    ["ts"] = ts,
                    ["user"] = null,
                    ["session"] = "host",
                    ["level"] = level,
                    ["tag"] = tag,
                    ["msg"] = msg ?? "",
                    ["data"] = data,
                };
                File.AppendAllText(PlayerDebugPath, JsonSerializer.Serialize(row) + Environment.NewLine, Encoding.UTF8);
            }
            catch { /* ignore */ }
        }
        try
        {
            if (level == "error" || level == "warn")
                Debug.WriteLine(human);
            else
                Debug.WriteLine(human);
        }
        catch { /* ignore */ }
    }

    /// <summary>Append raw Node server stdout/stderr without JSON wrapping.</summary>
    public static void TeeNode(string streamName, string line)
    {
        if (string.IsNullOrEmpty(line)) return;
        var ts = DateTime.UtcNow.ToString("o");
        lock (Gate)
        {
            try { _host?.WriteLine($"[{ts}] [NODE:{streamName}] {line}"); } catch { /* ignore */ }
        }
    }
}

public sealed class MainForm : Form
{
    readonly Panel _host = new() { Dock = DockStyle.Fill };
    readonly VideoView _video = new() { Dock = DockStyle.Fill };
    readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    readonly Label _bootSplash = new()
    {
        Dock = DockStyle.Fill,
        Text = "Starting…",
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.FromArgb(180, 180, 190),
        BackColor = Color.FromArgb(13, 13, 13),
        Font = new Font("Segoe UI", 18f, FontStyle.Regular),
    };
    readonly LibVLC _lib;
    readonly MediaPlayer _player;
    Process? _server;
    readonly System.Windows.Forms.Timer _tick = new() { Interval = 500 };
    const int Port = 8092;
    const string ServerUrl = "http://127.0.0.1:8092/";
    string? _lastOpenUrl;
    string _lastPushState = "";
    /** Last UI volume 0–100. Cached so GetVolume is sync and survives media reopen. */
    int _vlcVolumePercent = 100;
    bool _nativeFullscreen;
    FormBorderStyle _savedBorder = FormBorderStyle.Sizable;
    FormWindowState _savedWindowState = FormWindowState.Normal;
    Rectangle _savedBounds;

    public MainForm()
    {
        Text = "Cipher";
        Width = 1400;
        Height = 900;
        BackColor = Color.FromArgb(13, 13, 13);
        KeyPreview = true;
        KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape && _nativeFullscreen)
            {
                SetFullscreen(false);
                e.Handled = true;
            }
        };

        HostLog.Info("form.ctor", "creating LibVLC + WebView2 host");
        _lib = new LibVLC("--network-caching=1500", "--live-caching=1500", "--avcodec-hw=any");
        _player = new MediaPlayer(_lib);
        _player.Volume = _vlcVolumePercent;
        _video.MediaPlayer = _player;

        _host.Controls.Add(_web);
        _host.Controls.Add(_video);
        _video.SendToBack();
        _web.BringToFront();
        Controls.Add(_host);
        Controls.Add(_bootSplash);
        _bootSplash.BringToFront();

        // LibVLC raises these on a worker thread — never touch WebView2 there (crashes the process).
        _player.Playing += (_, _) => { HostLog.Info("vlc.event", "playing"); PushState("playing"); };
        _player.Paused += (_, _) => { HostLog.Info("vlc.event", "paused"); PushState("paused"); };
        _player.Stopped += (_, _) => { HostLog.Info("vlc.event", "stopped"); PushState("stopped"); };
        _player.EndReached += (_, _) => { HostLog.Info("vlc.event", "ended"); PushState("ended"); };
        _player.EncounteredError += (_, _) =>
        {
            HostLog.Error("vlc.event", $"error url={Truncate(_lastOpenUrl, 160)}");
            PushState("error");
        };
        _player.Buffering += (_, _) => PushState("buffering");

        // Only poll time while media is actually playing — idle browsing used to
        // ExecuteScript into WebView2 every 500ms for no reason.
        _tick.Tick += (_, _) =>
        {
            if (_player.IsPlaying) PushState(null);
        };
        Load += async (_, _) =>
        {
            try { await BootAsync(); }
            catch (Exception ex)
            {
                HostLog.Error("boot", ex);
                MessageBox.Show(ex.Message + "\n\nSee host.log in:\n" + HostLog.DataDir,
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        };
        FormClosing += (_, _) => Shutdown();
    }

    async Task BootAsync()
    {
        HostLog.Info("boot", "StartNodeServer");
        StartNodeServer();
        if (_server != null)
        {
            // Give listen a moment; EADDRINUSE exits quickly.
            await Task.Delay(400);
            if (_server.HasExited)
            {
                HostLog.Error("boot", $"node exited immediately code={_server.ExitCode} — see host.log NODE lines");
                MessageBox.Show(
                    "The local web server failed to start (port 8092 busy or node error).\n\n" +
                    "Check host.log in:\n" + HostLog.DataDir,
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
        }
        HostLog.Info("boot", "WaitForServerAsync");
        _bootSplash.Text = "Starting local server…";
        var ready = await WaitForServerAsync(TimeSpan.FromSeconds(30));
        if (!ready || (_server != null && _server.HasExited))
        {
            HostLog.Error("boot", $"server not ready (ready={ready}, exited={_server?.HasExited})");
            MessageBox.Show(
                "The local web server did not become ready.\n\nSee host.log in:\n" + HostLog.DataDir,
                Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Cipher", "WebView2");
        // Allow Playwright/CDP attach for automated smoke tests (debug builds only).
#if DEBUG
        Environment.SetEnvironmentVariable(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--remote-debugging-port=9223 --remote-allow-origins=*");
        HostLog.Info("webview", "remote debugging on port 9223");
#endif
        HostLog.Info("webview", $"EnsureCoreWebView2 userData={userData}");
        _bootSplash.Text = "Opening player…";
        var env = await CoreWebView2Environment.CreateAsync(null, userData);
        await _web.EnsureCoreWebView2Async(env);
        _web.DefaultBackgroundColor = Color.Transparent;
        _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;

        _web.CoreWebView2.NavigationStarting += (_, e) =>
            HostLog.Info("webview.nav", $"starting {e.Uri}");
        _web.CoreWebView2.NavigationCompleted += (_, e) =>
        {
            HostLog.Info("webview.nav", e.IsSuccess
                ? $"ok status={e.HttpStatusCode}"
                : $"FAIL status={e.HttpStatusCode} err={e.WebErrorStatus}");
            if (e.IsSuccess && !_bootSplash.IsDisposed) _bootSplash.Visible = false;
        };
        _web.CoreWebView2.ProcessFailed += (_, e) =>
            HostLog.Error("webview.processFailed", e.ProcessFailedKind.ToString());

        // Host object for JS: chrome.webview.hostObjects.sync.XsNative / window.chrome.webview
        _web.CoreWebView2.AddHostObjectToScript("XsNative", new XsNativeBridge(this));
        await _web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("""
            (() => {
              const raw = window.chrome && chrome.webview && chrome.webview.hostObjects && chrome.webview.hostObjects.sync
                ? chrome.webview.hostObjects.sync.XsNative
                : null;
              if (!raw) return;
              window.XsNative = {
                hasVlc: () => !!raw.hasVlc(),
                vlcOpen: (url, opts) => raw.vlcOpen(String(url), String(opts || '{}')),
                vlcPlay: () => raw.vlcPlay(),
                vlcPause: () => raw.vlcPause(),
                vlcStop: () => raw.vlcStop(),
                vlcSeek: (s) => raw.vlcSeek(Number(s) || 0),
                vlcGetTime: () => Number(raw.vlcGetTime()) || 0,
                vlcGetLength: () => Number(raw.vlcGetLength()) || 0,
                vlcIsPlaying: () => !!raw.vlcIsPlaying(),
                vlcSetVolume: (v) => raw.vlcSetVolume(Number(v) || 0),
                vlcGetVolume: () => {
                  const n = Number(raw.vlcGetVolume());
                  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
                },
                vlcGetSubtitleTracks: () => String(raw.vlcGetSubtitleTracks() || '[]'),
                vlcGetSubtitleTrack: () => Number(raw.vlcGetSubtitleTrack()),
                vlcSetSubtitleTrack: (id) => raw.vlcSetSubtitleTrack(Number(id)),
                hostLog: (level, msg) => { try { raw.hostLog(String(level || 'info'), String(msg || '')); } catch (_) {} },
                setImmersive: () => {},
                setLandscape: () => {},
                setFullscreen: (on) => raw.setFullscreen(!!on),
                isFullscreen: () => !!raw.isFullscreen(),
              };
            })();
            """);

        HostLog.Info("webview", $"Navigate {ServerUrl}");
        _web.CoreWebView2.Navigate(ServerUrl);
        _tick.Start();
        HostLog.Info("boot", "ready — host.log + player-debug.log in " + HostLog.DataDir);
    }

    void StartNodeServer()
    {
        var appDir = FindAppDir();
        if (appDir == null)
        {
            HostLog.Error("server", "Could not find app/server.js");
            MessageBox.Show("Could not find app/server.js next to this exe or under ../app.\nStart the Node server manually on port 8092.\n\nLogs: " + HostLog.DataDir,
                Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        // Previous desktop runs (or a wedged npm start) leave node listening on 8092. A new
        // child then hits EADDRINUSE, exits, and WaitForServer happily talks to the orphan —
        // which is how the UI ends up stuck on "Loading…" against a dead/hung server.
        FreeStaleNodeServers(Port);
        var data = HostLog.DataDir;
        var cfg = HostLog.ConfigDir;
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(cfg);
        var nodeExe = FindNodeExe();
        HostLog.Info("server", $"node={nodeExe} appDir={appDir} data={data} config={cfg} port={Port}");
        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = $"server.js --mode=apk --host=127.0.0.1 --port={Port} --ui=desktop --desktop=true --data=\"{data}\" --config=\"{cfg}\"",
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        _server = Process.Start(psi);
        if (_server == null)
        {
            HostLog.Error("server", "Process.Start returned null");
            return;
        }
        HostLog.Info("server", $"pid={_server.Id}");
        // Must drain redirected pipes or the Node process can stall when buffers fill.
        _server.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null) HostLog.TeeNode("out", e.Data);
        };
        _server.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null) HostLog.TeeNode("err", e.Data);
        };
        _server.Exited += (_, _) =>
        {
            try
            {
                HostLog.Warn("server.exit", $"code={_server.ExitCode}");
            }
            catch { /* ignore */ }
        };
        _server.EnableRaisingEvents = true;
        _server.BeginOutputReadLine();
        _server.BeginErrorReadLine();
    }

    /// <summary>
    /// Kill node processes that are LISTENING on our port (orphans from prior runs).
    /// </summary>
    static void FreeStaleNodeServers(int port)
    {
        var pids = new HashSet<int>();
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c netstat -ano | findstr :{port}",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi);
            if (p == null) return;
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0) continue;
                if (int.TryParse(parts[^1], out var pid) && pid > 0) pids.Add(pid);
            }
        }
        catch (Exception ex)
        {
            HostLog.Warn("server.freePort", ex.Message);
            return;
        }

        foreach (var pid in pids)
        {
            try
            {
                using var proc = Process.GetProcessById(pid);
                if (!proc.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase))
                {
                    HostLog.Warn("server.freePort", $"pid={pid} is {proc.ProcessName}, not killing");
                    continue;
                }
                HostLog.Warn("server.freePort", $"killing stale node pid={pid} on port {port}");
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(4000);
            }
            catch (Exception ex)
            {
                HostLog.Warn("server.freePort", $"pid={pid}: {ex.Message}");
            }
        }
        if (pids.Count > 0) Thread.Sleep(400);
    }

    static string? FindAppDir()
    {
        var candidates = new[]
        {
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "app")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "app")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "app")),
        };
        foreach (var c in candidates)
        {
            HostLog.Info("server.find", $"probe {c}");
            if (File.Exists(Path.Combine(c, "server.js"))) return c;
        }
        return null;
    }

    /// <summary>Prefer bundled portable Node next to the exe, then PATH.</summary>
    static string FindNodeExe()
    {
        var bundled = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "node", "node.exe"),
            Path.Combine(AppContext.BaseDirectory, "node.exe"),
        };
        foreach (var c in bundled)
        {
            if (File.Exists(c))
            {
                HostLog.Info("server.node", $"bundled {c}");
                return c;
            }
        }
        HostLog.Info("server.node", "using PATH node");
        return "node";
    }

    static async Task<bool> WaitForServerAsync(TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        while (DateTime.UtcNow < until)
        {
            try
            {
                var r = await http.GetAsync(ServerUrl);
                if ((int)r.StatusCode < 500)
                {
                    HostLog.Info("server.wait", $"ready status={(int)r.StatusCode}");
                    return true;
                }
                HostLog.Warn("server.wait", $"status={(int)r.StatusCode}");
            }
            catch (Exception ex)
            {
                HostLog.Info("server.wait", $"retry: {ex.GetType().Name}");
            }
            await Task.Delay(300);
        }
        return false;
    }

    void PushState(string? stateOverride)
    {
        // LibVLC events (and some COM callbacks) arrive off the UI thread. Reading
        // CoreWebView2 or calling ExecuteScriptAsync there throws InvalidOperationException
        // and was crashing the desktop app right as a channel started buffering/playing.
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(() => PushState(stateOverride)); }
            catch (ObjectDisposedException) { /* shutting down */ }
            catch (InvalidOperationException) { /* handle gone */ }
            return;
        }
        try
        {
            if (_web.CoreWebView2 == null) return;
            var time = Math.Max(0, _player.Time) / 1000.0;
            var length = _player.Length > 0 ? _player.Length / 1000.0 : 0;
            var state = stateOverride ?? (_player.IsPlaying ? "playing" : "paused");
            // Avoid spamming host.log every 500ms — only when state label changes (or forced).
            if (stateOverride != null || state != _lastPushState)
            {
                _lastPushState = state;
                if (stateOverride != null)
                    HostLog.Info("vlc.pushState", $"{state} t={time:0.##} len={length:0.##}");
            }
            var payload = JsonSerializer.Serialize(new { state, time, length });
            _ = _web.CoreWebView2.ExecuteScriptAsync($"window.__vlcOnState&&window.__vlcOnState({payload})");
        }
        catch (Exception ex)
        {
            HostLog.Warn("vlc.pushState", ex.Message);
        }
    }

    void Shutdown()
    {
        HostLog.Info("shutdown", "FormClosing");
        _tick.Stop();
        try { _player.Stop(); } catch { /* ignore */ }
        try { _player.Dispose(); } catch { /* ignore */ }
        try { _lib.Dispose(); } catch { /* ignore */ }
        if (_server != null && !_server.HasExited)
        {
            try
            {
                HostLog.Info("shutdown", $"Kill node pid={_server.Id}");
                _server.Kill(entireProcessTree: true);
            }
            catch (Exception ex)
            {
                HostLog.Warn("shutdown", ex.Message);
            }
        }
    }

    internal void Open(string url, string optsJson)
    {
        BeginInvoke(() =>
        {
            try
            {
                _lastOpenUrl = url;
                HostLog.Info("vlc.open", Truncate(url, 240));
                HostLog.Info("vlc.open.opts", string.IsNullOrWhiteSpace(optsJson) ? "{}" : Truncate(optsJson, 200));
                using var media = new Media(_lib, url, FromType.FromLocation);
                media.AddOption(":network-caching=1500");
                // Default: no burned-in / auto-selected SPU — JS applies the saved preference.
                media.AddOption(":no-spu");
                _player.Play(media);
                // New media can reset libVLC volume — restore the fader level.
                _player.Volume = _vlcVolumePercent;
                using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(optsJson) ? "{}" : optsJson);
                if (doc.RootElement.TryGetProperty("start", out var startEl))
                {
                    var start = startEl.GetDouble();
                    if (start > 0.4)
                    {
                        var ms = (long)Math.Round(start * 1000);
                        HostLog.Info("vlc.open.seek", $"startSec={start} → {ms}ms");
                        Task.Delay(400).ContinueWith(_ => BeginInvoke(() =>
                        {
                            try { _player.Time = ms; }
                            catch (Exception ex) { HostLog.Warn("vlc.open.seek", ex.Message); }
                        }));
                    }
                }
            }
            catch (Exception ex)
            {
                HostLog.Error("vlc.open", ex);
                MessageBox.Show(ex.Message + "\n\nSee host.log:\n" + HostLog.HostLogPath, "VLC open failed");
                PushState("error");
            }
        });
    }

    internal void Play() => BeginInvoke(() =>
    {
        HostLog.Info("vlc.play", "");
        try
        {
            // After SetPause(true), resume with SetPause(false) — calling Play() again
            // often leaves video frozen while audio continues (common with --avcodec-hw=any).
            if (_player.Media != null)
            {
                _player.SetPause(false);
                if (!_player.IsPlaying)
                    _player.Play();
                return;
            }
        }
        catch (Exception ex) { HostLog.Warn("vlc.play", ex.Message); }
        _player.Play();
    });
    internal void Pause() => BeginInvoke(() =>
    {
        HostLog.Info("vlc.pause", "");
        _player.SetPause(true);
    });
    internal void StopPlayback() => BeginInvoke(() =>
    {
        HostLog.Info("vlc.stop", "");
        _player.Stop();
    });
    internal void Seek(double seconds) => BeginInvoke(() =>
    {
        HostLog.Info("vlc.seek", $"{seconds:0.###}s");
        _player.Time = (long)Math.Max(0, seconds * 1000);
    });
    internal double GetTime() => Math.Max(0, _player.Time) / 1000.0;
    internal double GetLength() => _player.Length > 0 ? _player.Length / 1000.0 : 0;
    internal bool IsPlaying() => _player.IsPlaying;
    internal void SetVolume(double level)
    {
        _vlcVolumePercent = (int)Math.Round(Math.Clamp(level, 0, 1) * 100);
        HostLog.Info("vlc.volume", $"{_vlcVolumePercent}%");
        void apply()
        {
            try { _player.Volume = _vlcVolumePercent; }
            catch (Exception ex) { HostLog.Warn("vlc.volume", ex.Message); }
        }
        if (InvokeRequired) BeginInvoke(apply);
        else apply();
    }
    internal double GetVolume() => _vlcVolumePercent / 100.0;

    /// <summary>JSON array of { id, name } for available subtitle (SPU) tracks. Excludes the disable (-1) row.</summary>
    internal string GetSubtitleTracksJson()
    {
        try
        {
            var tracks = _player.SpuDescription;
            if (tracks == null || tracks.Length == 0) return "[]";
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartArray();
                foreach (var t in tracks)
                {
                    if (t.Id == -1) continue;
                    writer.WriteStartObject();
                    writer.WriteNumber("id", t.Id);
                    writer.WriteString("name", string.IsNullOrWhiteSpace(t.Name) ? $"Track {t.Id}" : t.Name);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
            }
            return Encoding.UTF8.GetString(stream.ToArray());
        }
        catch (Exception ex)
        {
            HostLog.Warn("vlc.subs.list", ex.Message);
            return "[]";
        }
    }

    internal int GetSubtitleTrack()
    {
        try { return _player.Spu; }
        catch { return -1; }
    }

    internal void SetSubtitleTrack(int id)
    {
        void apply()
        {
            try
            {
                var ok = _player.SetSpu(id);
                HostLog.Info("vlc.subs.set", $"id={id} ok={ok}");
            }
            catch (Exception ex) { HostLog.Warn("vlc.subs.set", ex.Message); }
        }
        if (InvokeRequired) BeginInvoke(apply);
        else apply();
    }

    internal bool IsFullscreen() => _nativeFullscreen;

    internal void SetFullscreen(bool on)
    {
        void apply()
        {
            if (on == _nativeFullscreen) return;
            if (on)
            {
                _savedBorder = FormBorderStyle;
                _savedWindowState = WindowState;
                _savedBounds = WindowState == FormWindowState.Maximized ? RestoreBounds : Bounds;
                // Borderless cover of the current screen — no title bar / outline.
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Normal;
                Bounds = Screen.FromControl(this).Bounds;
                _nativeFullscreen = true;
                HostLog.Info("ui.fullscreen", "enter");
            }
            else
            {
                FormBorderStyle = _savedBorder;
                WindowState = FormWindowState.Normal;
                Bounds = _savedBounds;
                WindowState = _savedWindowState;
                _nativeFullscreen = false;
                HostLog.Info("ui.fullscreen", "exit");
            }
            NotifyFullscreen(_nativeFullscreen);
        }
        if (InvokeRequired) BeginInvoke(apply);
        else apply();
    }

    void NotifyFullscreen(bool on)
    {
        try
        {
            if (_web.CoreWebView2 == null) return;
            var payload = on ? "true" : "false";
            _ = _web.CoreWebView2.ExecuteScriptAsync(
                $"window.__onNativeFullscreen&&window.__onNativeFullscreen({payload})");
        }
        catch (Exception ex)
        {
            HostLog.Warn("ui.fullscreen.notify", ex.Message);
        }
    }

    static string Truncate(string? s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= max ? s : s[..max] + "…";
    }
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public class XsNativeBridge
{
    readonly MainForm _form;
    public XsNativeBridge(MainForm form) => _form = form;

    public bool hasVlc() => true;
    public void vlcOpen(string url, string optsJson) => _form.Open(url, optsJson);
    public void vlcPlay() => _form.Play();
    public void vlcPause() => _form.Pause();
    public void vlcStop() => _form.StopPlayback();
    public void vlcSeek(double seconds) => _form.Seek(seconds);
    public double vlcGetTime() => _form.GetTime();
    public double vlcGetLength() => _form.GetLength();
    public bool vlcIsPlaying() => _form.IsPlaying();
    public void vlcSetVolume(double level) => _form.SetVolume(level);
    public double vlcGetVolume() => _form.GetVolume();
    public string vlcGetSubtitleTracks() => _form.GetSubtitleTracksJson();
    public int vlcGetSubtitleTrack() => _form.GetSubtitleTrack();
    public void vlcSetSubtitleTrack(int id) => _form.SetSubtitleTrack(id);
    public void hostLog(string level, string msg)
    {
        var lvl = string.IsNullOrWhiteSpace(level) ? "info" : level.Trim().ToLowerInvariant();
        if (lvl == "error") HostLog.Error("ui→host", msg ?? "");
        else if (lvl == "warn") HostLog.Warn("ui→host", msg ?? "");
        else HostLog.Info("ui→host", msg ?? "");
    }
    public void setImmersive(bool on) { }
    public void setLandscape(bool on) { }
    public void setFullscreen(bool on) => _form.SetFullscreen(on);
    public bool isFullscreen() => _form.IsFullscreen();
}
