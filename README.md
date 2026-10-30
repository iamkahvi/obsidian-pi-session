# obsidian-pi-session

An Obsidian plugin that shows a card for a Pi session. Put a session ID in a `pi-session` code block:

````markdown
```pi-session
01a188fb-137d-7453-8857-7363f805b91e
```
````

The card shows the session name, start time, `cwd`, model, message counts, the first prompt, and the last reply.

The plugin reads session files from `~/.pi/agent/sessions/`. It works only on desktop. It does not use an LLM.

## Open in Herdr.app

The card has an "Open in Herdr.app" button:

1. If the session is live in a Herdr TUI pane, the plugin shows a notice and does not open it. This prevents a second writer. This check is off for now. Set `BLOCK_IF_LIVE_IN_HERDR_TUI` in `main.js` to turn it on.
2. If a live Herdr.app terminal runs `pi --session <this session>`, the plugin focuses it.
3. If not, the plugin opens a new Herdr.app tab in the session `cwd` and resumes the session.

The plugin starts Herdr.app if it is not running. It uses `~/.local/bin/hc`, `~/.local/bin/herdr-app`, and `/opt/homebrew/bin/herdr`.

## Open button settings

Open **Settings → Community plugins → Pi Session** to configure the card action:

- **Show open button** hides or displays the action on every Pi session card.
- **Open target** chooses either **Herdr.app** (the default) or a **Custom command**.
- For the Herdr.app target, **Pi executable** accepts an explicit executable path. Leave it empty to detect Pi from the app `PATH`, `~/.bun/bin/pi`, `~/.local/bin/pi`, Homebrew, or the former `tec` location.
- A custom command is run without a shell. Its arguments must be a JSON array of strings, so paths and session content cannot be interpreted as shell syntax. Arguments may contain these placeholders:
  - `{sessionFile}`: absolute path to the Pi JSONL session
  - `{sessionId}`: the ID in the `pi-session` code block
  - `{cwd}`: the session working directory

For example, a command of `/path/to/your-launcher` with arguments
`["--session", "{sessionFile}", "--cwd", "{cwd}"]` passes the selected session to that launcher.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/pi-session/`. Then turn on "Pi Session" in Settings > Community plugins.
