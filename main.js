const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, ".pi", "agent", "sessions");
const MAX_CHARS = 300;
const DEFAULT_SETTINGS = {
  openEnabled: true,
  openTarget: "herdr-app",
  buttonLabel: "",
  customCommand: "",
  customArguments: "[]",
};

// Obsidian does not get the login shell PATH, so use absolute paths.
const HC = path.join(HOME, ".local", "bin", "hc");
const HERDR_APP = path.join(HOME, ".local", "bin", "herdr-app");
const HERDR = "/opt/homebrew/bin/herdr";
const PI = path.join(HOME, ".local", "state", "tec", "toolchain", "base_profile", "bin", "pi");
const HERDR_APP_BUNDLE = "dev.herdr.app";
// TEMPORARY: false lets the button open a session that is live in the Herdr TUI.
// Two Pi processes then write to the same session file.
const BLOCK_IF_LIVE_IN_HERDR_TUI = false;
const ENV = {
  ...process.env,
  PATH: [path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/bin", "/bin", process.env.PATH].join(":"),
};

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: ENV, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} ${args[0] || ""}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function matchesSession(value, file, id) {
  return value === file || value === id || (typeof value === "string" && value.endsWith(`_${id}.jsonl`));
}

// Guard: a session that is live in the Herdr TUI must not get a second writer.
async function findInHerdrTui(file, id) {
  if (!fs.existsSync(HERDR)) return null;
  let list;
  try { list = await run(HERDR, ["session", "list"]); } catch { return null; }
  const sessions = list.split("\n").slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c[1] === "running")
    .map((c) => c[0]);
  const hits = await Promise.all(sessions.map(async (s) => {
    try {
      const out = JSON.parse(await run(HERDR, ["--session", s, "agent", "list"]));
      const a = (out.result.agents || []).find((x) => matchesSession(x.agent_session && x.agent_session.value, file, id));
      return a ? { session: s, pane: a.pane_id } : null;
    } catch { return null; }
  }));
  return hits.find(Boolean) || null;
}

async function findInHerdrApp(file, id) {
  const ls = JSON.parse(await run(HC, ["ls", "--json"]));
  // Herdr.app wraps commands in `zsh -ic`, so `agent` is "zsh". Check argv and the foreground process.
  const live = (ls.terminals || []).filter((t) => t.state === "live");
  const details = await Promise.all(live.map(async (t) => {
    try { return JSON.parse(await run(HC, ["get", t.address, "--json"])); } catch { return null; }
  }));
  const hit = details.find((d) => d
    && (d.argv || []).some((a) => matchesSession(a, file, id))
    && d.foreground && (d.foreground.argv || [])[0] === "pi");
  return hit ? hit.address : null;
}

async function ensureHerdrApp() {
  try { await run(HERDR_APP, ["status"]); return; } catch {}
  await run("/usr/bin/open", ["-b", HERDR_APP_BUNDLE]);
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try { await run(HERDR_APP, ["status"]); return; } catch {}
  }
  throw new Error("Herdr.app did not start in 10 s");
}

async function openInHerdrApp(file, id, cwd) {
  const tui = BLOCK_IF_LIVE_IN_HERDR_TUI ? await findInHerdrTui(file, id) : null;
  if (tui) return `Live in Herdr TUI (session ${tui.session}, pane ${tui.pane}). Not opened.`;
  await ensureHerdrApp();
  const terminal = await findInHerdrApp(file, id);
  let msg;
  if (terminal) {
    await run(HERDR_APP, ["do", "agent.focus", "--terminal", terminal]);
    msg = `Focused ${terminal} in Herdr.app.`;
  } else {
    if (!cwd || !fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
    const out = JSON.parse(await run(HERDR_APP, ["do", "tab.new", "--folder", cwd, "--argv", JSON.stringify([PI, "--session", file])]));
    msg = `Opened ${out.terminal} in Herdr.app.`;
  }
  await run("/usr/bin/open", ["-b", HERDR_APP_BUNDLE]);
  return msg;
}

function openButtonLabel(settings) {
  if (settings.buttonLabel.trim()) return settings.buttonLabel.trim();
  return settings.openTarget === "herdr-app" ? "Open in Herdr.app" : "Open session";
}

function expandArgument(value, file, id, cwd) {
  return value
    .replaceAll("{sessionFile}", file)
    .replaceAll("{sessionId}", id)
    .replaceAll("{cwd}", cwd || "");
}

async function openWithCustomCommand(settings, file, id, cwd) {
  const command = settings.customCommand.trim();
  if (!command) throw new Error("Custom command is empty. Configure it in Pi Session settings.");

  let args;
  try {
    args = JSON.parse(settings.customArguments || "[]");
  } catch {
    throw new Error("Custom arguments must be a JSON array of strings.");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Custom arguments must be a JSON array of strings.");
  }

  await run(command, args.map((arg) => expandArgument(arg, file, id, cwd)));
  return `Ran ${command}.`;
}

function findSessionFile(id) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    const full = path.join(SESSIONS_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const hit = fs.readdirSync(full).find((f) => f.endsWith(`_${id}.jsonl`));
    if (hit) return path.join(full, hit);
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function cut(s) {
  s = (s || "").trim();
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + "..." : s;
}

function parseSession(file) {
  const info = { name: null, cwd: null, start: null, model: null, users: 0, assistants: 0, firstUser: "", lastAssistant: "" };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session") { info.cwd = e.cwd; info.start = e.timestamp; }
    else if (e.type === "session_info" && e.name) info.name = e.name;
    else if (e.type === "model_change") info.model = `${e.provider}/${e.modelId}`;
    else if (e.type === "message" && e.message) {
      const m = e.message;
      if (m.role === "user") {
        info.users++;
        if (!info.firstUser) info.firstUser = textOf(m.content);
      } else if (m.role === "assistant") {
        info.assistants++;
        if (m.model) info.model = m.provider ? `${m.provider}/${m.model}` : m.model;
        const t = textOf(m.content);
        if (t.trim()) info.lastAssistant = t;
      }
    }
  }
  return info;
}

class PiSessionSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show open button")
      .setDesc("Show an action button on Pi session cards.")
      .addToggle((toggle) => toggle
        .setValue(settings.openEnabled)
        .onChange(async (value) => {
          settings.openEnabled = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (!settings.openEnabled) return;

    new Setting(containerEl)
      .setName("Open target")
      .setDesc("Choose where the session button opens the session.")
      .addDropdown((dropdown) => dropdown
        .addOption("herdr-app", "Herdr.app")
        .addOption("custom-command", "Custom command")
        .setValue(settings.openTarget)
        .onChange(async (value) => {
          settings.openTarget = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Button label")
      .setDesc(`Leave empty for “${openButtonLabel({ ...settings, buttonLabel: "" })}”.`)
      .addText((text) => text
        .setPlaceholder(openButtonLabel({ ...settings, buttonLabel: "" }))
        .setValue(settings.buttonLabel)
        .onChange(async (value) => {
          settings.buttonLabel = value;
          await this.plugin.saveSettings();
        }));

    if (settings.openTarget !== "custom-command") return;

    new Setting(containerEl)
      .setName("Command")
      .setDesc("Executable path or command name to run when opening a session.")
      .addText((text) => text
        .setPlaceholder("/usr/bin/open")
        .setValue(settings.customCommand)
        .onChange(async (value) => {
          settings.customCommand = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Arguments")
      .setDesc("JSON array of arguments. Use {sessionFile}, {sessionId}, and {cwd} as placeholders.")
      .addTextArea((text) => text
        .setPlaceholder('["--session", "{sessionFile}"]')
        .setValue(settings.customArguments)
        .onChange(async (value) => {
          settings.customArguments = value;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = class PiSessionPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new PiSessionSettingsTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor("pi-session", (source, el) => {
      const id = source.trim();
      const card = el.createDiv({ cls: "pi-session-card" });
      const file = id && findSessionFile(id);
      if (!file) {
        card.createDiv({ cls: "pi-session-error", text: `Session not found: ${id}` });
        return;
      }
      const s = parseSession(file);
      card.createDiv({ cls: "pi-session-title", text: s.name || "(no name)" });
      const meta = card.createDiv({ cls: "pi-session-meta" });
      meta.setText([
        s.start && new Date(s.start).toLocaleString(),
        s.cwd,
        s.model,
        `${s.users} user / ${s.assistants} assistant`,
      ].filter(Boolean).join("  ·  "));
      const row = (label, text) => {
        const r = card.createDiv({ cls: "pi-session-row" });
        r.createDiv({ cls: "pi-session-label", text: label });
        r.createDiv({ cls: "pi-session-text", text: cut(text) || "(none)" });
      };
      row("First prompt", s.firstUser);
      row("Last reply", s.lastAssistant);
      const footer = card.createDiv({ cls: "pi-session-footer" });
      footer.createDiv({ cls: "pi-session-id", text: id });
      if (!this.settings.openEnabled) return;

      const btn = footer.createEl("button", { text: openButtonLabel(this.settings) });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const result = this.settings.openTarget === "custom-command"
            ? await openWithCustomCommand(this.settings, file, id, s.cwd)
            : await openInHerdrApp(file, id, s.cwd);
          new Notice(result);
        } catch (e) {
          new Notice(`Pi Session: ${e.message}`, 8000);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
