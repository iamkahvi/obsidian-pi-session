# obsidian-pi-session

An Obsidian plugin that shows a card for a Pi session. Put a session ID in a `pi-session` code block:

````markdown
```pi-session
01a188fb-137d-7453-8857-7363f805b91e
```
````

The card shows the session title and first prompt. The plugin reads session files from `~/.pi/agent/sessions/`, works only on desktop, and does not use an LLM.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/pi-session/`. Then turn on "Pi Session" in Settings > Community plugins.
