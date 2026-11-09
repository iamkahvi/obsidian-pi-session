# obsidian-pi-session

An Obsidian plugin that shows a card for a Pi session. Put a session ID in a `pi-session` code block:

````markdown
```pi-session
01a188fb-137d-7453-8857-7363f805b91e
```
````

The card shows the session name, start time, `cwd`, model, message counts, the first prompt, and the last reply.

The plugin reads session files from `~/.pi/agent/sessions/`. It works only on desktop. It does not use an LLM.

## Start a session

Select text in a note and run **Pi Session: Start Pi session from selection** from the command palette. The plugin opens Pi in a tab in the Rex session named `vault`. It creates that Rex session if necessary. Pi uses `$HOME` as its working directory.

After Pi saves the first prompt, the plugin replaces the selection with a `pi-session` block. If the note changes or Pi does not save the prompt within 60 seconds, the plugin leaves the note unchanged. A notice gives the session ID so you can add the block yourself.

Pi treats a prompt that starts with `@` as a file argument. The plugin adds a space before that prompt to preserve its text. Pi can also interpret prompts that start with `/` as commands. If a command does not save a prompt, the plugin leaves the note unchanged.

## Open in Rex

The card has an **Open in Rex** button. It focuses an existing Pi tab that the plugin created in the `vault` session. If no such tab is active, it opens a new tab and resumes Pi in the session's original working directory. The plugin starts Rex if necessary.

The plugin cannot detect a session that you opened outside its own Rex tabs. Do not open the same Pi session in two processes.

## Open button settings

Open **Settings → Community plugins → Pi Session** to configure the card action:

- **Show open button** hides or displays the action on every Pi session card.
- **Open target** chooses either **Rex** (the default) or a **Custom command**.
- **Pi executable** accepts an explicit executable path. Leave it empty to detect Pi from the app `PATH`, `~/.bun/bin/pi`, `~/.local/bin/pi`, Homebrew, or the former `tec` location. This setting also applies to new sessions.
- A custom command is run without a shell. Its arguments must be a JSON array of strings, so paths and session content cannot be interpreted as shell syntax. Arguments may contain these placeholders:
  - `{sessionFile}`: absolute path to the Pi JSONL session
  - `{sessionId}`: the ID in the `pi-session` code block
  - `{cwd}`: the session working directory

For example, a command of `/path/to/your-launcher` with arguments
`["--session", "{sessionFile}", "--cwd", "{cwd}"]` passes the selected session to that launcher.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/pi-session/`. Then turn on "Pi Session" in Settings > Community plugins. Install Pi and Rex on the same desktop. The plugin reads Pi sessions from the default directory, `~/.pi/agent/sessions/`.

## Test

Run `node --test test.js`. The tests use a mock Rex CLI and do not open a Rex tab.
