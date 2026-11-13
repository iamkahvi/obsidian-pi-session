# obsidian-pi-session

Start and view Pi sessions in Obsidian. Desktop only.

![Example Pi session card with sample data](assets/session-card.png)

## Install

1. Install Pi and Rex.
2. Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/pi-session/`.
3. Enable **Pi Session** in Obsidian community plugins.

The plugin reads sessions from `~/.pi/agent/sessions/`.

### Pi extension

The Pi extension lets Obsidian find open sessions in Rex. The Rex CLI must be on Pi's `PATH`.

1. Remove any previous installation of `rex-session-label` from Pi's extension paths.
2. Run these commands from the root of this repository:

   ```sh
   mkdir -p "$HOME/.pi/agent/extensions"
   ln -s "$PWD/pi/rex-session-label" "$HOME/.pi/agent/extensions/rex-session-label"
   ```

3. Start Pi or run `/reload` in an open Pi session.

## Start a session

1. Select text in a note.
2. Run **Pi Session: Start Pi session from selection** from the command palette.

Rex uses or creates the `vault` session. Pi uses `$HOME` as its `cwd`. After Pi saves the prompt, the plugin waits up to 10 seconds for the session name. Then it names the Rex tab and replaces the text with a `pi-session` block.

If the note changes or Pi saves no prompt within 60 seconds, the plugin keeps the text. A notice gives the session ID. Pi can treat prompts that start with `/` as commands. The plugin adds a space before prompts that start with `@`.

## Open a session

Click **Open in Rex** to focus or resume a session.

To add a card yourself, run `/copy-obsidian-block` in Pi and paste the block into a note. The block uses the session name as the title. To set a different title, use `/copy-obsidian-block <title>`. The command needs the Pi extension.

A block has an `id:` line and an optional `title:` line, in any order:

````markdown
```pi-session
id: 01a188fb-137d-7453-8857-7363f805b91e
title: exploration
```
````

The `title:` line replaces the Rex tab name and the Pi session name. It also names a new Rex tab when you click **Open in Rex**. A block that contains only the session ID also works.

Do not open a Pi session in two processes. The plugin cannot detect sessions outside Rex or sessions without the extension label. It shows a notice if it cannot verify a labeled pane. Rex Remote Control must be on to select a tab in the app. The first time, macOS can ask you to let Obsidian control Rex.

If Obsidian stops during a request, confirm that no request is active. Then remove the lock file shown in the notice.

Cards do not update automatically. Run **Pi Session: Refresh Pi session cards and titles** to update them.

The card title is the Rex tab name. The refresh command reads the tab names from Rex. The plugin keeps each name after the tab closes and uses it when it opens a new tab. Cards without a Rex tab name show the Pi session name. The command skips default names such as `Window 635b87d7` and tabs with more than one Pi pane.

## Settings

Use **Settings → Community plugins → Pi Session** to choose the button target and Pi executable path.

Set **Card layout** to **Compact** to show only the title, the first 3 lines of the first prompt, start time, message count, session ID, and button.

Custom command arguments must be a JSON array of strings. Use `{sessionFile}`, `{sessionId}`, and `{cwd}` as placeholders. The plugin runs custom commands without a shell.

## Test

Run the Obsidian plugin tests with `node --test test.js`. Run the Pi extension tests with `bun test pi/rex-session-label/tests`.
