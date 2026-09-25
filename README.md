# MuMu Reconnect

Keeps your Roblox games alive on **MuMuPlayer**. It watches every running
instance, notices when one drops back to the Roblox home screen, and rejoins
the link you set for that instance — including private server links.

Built for people running several cloned instances at once.

## What it does

- **Finds every running instance**, cloned ones included. Cloned MuMu instances
  never register themselves with ADB, so the app connects to each one directly
  instead of waiting for them to appear.
- **Knows the difference between "in a game" and "sitting on the home screen".**
  Roblox draws both from the same Android activity, so the app checks whether
  Roblox actually holds a game-server connection.
- **Rejoins per instance.** Each instance gets its own link, so every account can
  sit in a different game or private server.
- **Leaves healthy games alone.** A grace period covers loading and joining, and
  nothing restarts while a game is running.

## Install

Grab the latest installer or portable build from the
[Releases](../../releases) page and run it. Windows only — MuMuPlayer is a
Windows emulator.

## Using it

1. Start the MuMu instances you want watched.
2. Open MuMu Reconnect. Running instances show up in the left column.
3. Click one, paste the game or private server link, and turn on
   **Auto-reconnect this instance**.
4. Hit **Start watching**.

Repeat step 3 for each instance. Settings are saved as you type.

The **Rejoin now** button forces an immediate rejoin, which is handy for
checking a link works before leaving it running.

### Settings

| Setting | What it does |
| --- | --- |
| Check every | How often each instance is inspected |
| Scan for instances | How often the app looks for new instances |
| Grace before rejoin | How long Roblox may sit outside a game before it counts as stuck |
| Cooldown between tries | Minimum gap between reconnect rounds for one instance |
| Join timeout | How long to wait for a game after sending the link |
| Attempts per round | Launch attempts before backing off |

If MuMuPlayer is installed somewhere unusual, point the app at the folder in
Settings — the one that contains `nx_device` and `nx_main`.

### If it says it cannot find MuMuPlayer

Pick the **install** folder, not the data folder: the one holding `nx_device`
and `nx_main` side by side. Usually one of

```
C:\Program Files\Netease\MuMuPlayer
C:\Program Files\Netease\MuMuPlayerGlobal-12.0
```

The numbered folder inside `nx_device` is the emulator build, and it differs
between versions — `12.0` on MuMuPlayer 12, `15.0` on newer ones. Any of them
works; the app picks the newest it finds. To locate it, paste this into
PowerShell (not wrapped in `powershell -c`, which eats the `$_`):

```powershell
Get-PSDrive -PSProvider FileSystem | %{ Get-ChildItem $_.Root -Filter nx_device -Directory -Recurse -Depth 4 -ErrorAction SilentlyContinue } | %{ $_.Parent.FullName }
```

## Your links stay yours

Everything you configure — private server links included — is written to
`%APPDATA%/MuMu Reconnect/config.json` on your own PC. Nothing is bundled into
the app, uploaded, or shared.

The app makes exactly one outbound request: on launch it asks GitHub whether a
newer release exists, so it can show an update banner. That request sends
nothing about you or your setup — no links, no settings, no machine details —
and the app works normally if it fails or is blocked.

## Building from source

```bash
npm install
npm start
```

To produce an installer and a portable .exe in `release/`:

```bash
npm run dist
```

## How the detection works

Two things make this reliable where a simple "is Roblox open" check is not:

- **Instance discovery** comes from `MuMuManager.exe info -v all`, which lists
  every instance with its ADB port. Port probing (`16384 + 32 * index`) is the
  fallback if MuMuManager is missing.
- **In-game detection** reads `/proc/net/udp` on the emulator. A client that is
  in a game holds an *unconnected* UDP socket owned by Roblox. Roblox's ordinary
  web traffic is QUIC, which shows up connected to port 443 — the remote port is
  what tells the two apart.

## License

MIT
