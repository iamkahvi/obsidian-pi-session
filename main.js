const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, ".pi", "agent", "sessions");
const MAX_CHARS = 300;
const DEFAULT_SETTINGS = {
  openEnabled: true,
  openTarget: "rex",
  buttonLabel: "",
  customCommand: "",
  customArguments: "[]",
  piExecutable: "",
};

const REX_SESSION = "vault";
const REX_APP_BUNDLE = "com.superlogical.rex";
const ENV = {
  ...process.env,
  PATH: [path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/bin", "/bin", process.env.PATH].filter(Boolean).join(":"),
};

function expandHome(value) {
  if (value === "~") return HOME;
  return value.startsWith("~/") ? path.join(HOME, value.slice(2)) : value;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectPiExecutable() {
  const pathCandidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "pi"));
  const standardCandidates = [
    path.join(HOME, ".bun", "bin", "pi"),
    path.join(HOME, ".local", "bin", "pi"),
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
    path.join(HOME, ".local", "state", "tec", "toolchain", "base_profile", "bin", "pi"),
  ];
  return [...new Set([...pathCandidates, ...standardCandidates])].find(isExecutable) || null;
}

function findPiExecutable(configuredPath) {
  if (configuredPath.trim()) {
    const executable = expandHome(configuredPath.trim());
    if (isExecutable(executable)) return executable;
    throw new Error(`Configured Pi executable is not executable: ${executable}`);
  }

  const executable = detectPiExecutable();
  if (executable) return executable;
  throw new Error("Pi executable not found. Set it in Settings → Community plugins → Pi Session.");
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: ENV, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} ${args[0] || ""}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findRexExecutable() {
  const candidates = [
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "rex")),
    path.join(HOME, ".local", "bin", "rex"),
    path.join(HOME, "Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex"),
  ];
  const executable = candidates.find(isExecutable);
  if (!executable) throw new Error("Rex executable not found.");
  return executable;
}

async function rexJson(rex, args) {
  return JSON.parse(await run(rex, args));
}

async function findVaultSession(rex) {
  const { sessions } = await rexJson(rex, ["ls", "--json"]);
  const matches = (sessions || []).filter((session) => session.label === REX_SESSION);
  if (matches.length > 1) throw new Error('More than one Rex session is named "vault".');
  return matches[0] || null;
}

async function showInRex(rex, sessionId, windowId) {
  if (process.platform === "darwin") await run("/usr/bin/open", ["-b", REX_APP_BUNDLE]);
  for (let i = 0; i < 50; i++) {
    const { clients } = await rexJson(rex, ["client", "ls", "--json"]);
    const apps = (clients || []).filter((client) => client.info?.kind === "app" && client.connection_state === "connected");
    if (apps.length > 1) throw new Error("More than one Rex app is connected. Select the vault session in Rex.");
    if (apps.length === 1) {
      await run(rex, ["-C", apps[0].client_id, "do", "session.select", `session_id=${sessionId}`, `window_id=${windowId}`]);
      return;
    }
    await sleep(200);
  }
  throw new Error("Rex app did not connect. Select the vault session in Rex.");
}

let rexWindowQueue = Promise.resolve();

function createRexWindow(settings, rex, id, cwd, piArgs) {
  const create = async () => {
    const session = await findVaultSession(rex);
    const label = `pi:${id}`;
    const piCommand = [findPiExecutable(settings.piExecutable), ...piArgs];
    if (session) {
      const result = await rexJson(rex, ["window", "new", "-s", session.session_id, label, "-c", cwd, "--json", "--", ...piCommand]);
      return { sessionId: session.session_id, windowId: result.window_id };
    }
    const result = await rexJson(rex, ["new", REX_SESSION, "-c", cwd, "--window", label, "--json", "--", ...piCommand]);
    return { sessionId: result.session_id, windowId: result.initial_windows[0].window_id };
  };
  const result = rexWindowQueue.then(create);
  rexWindowQueue = result.catch(() => {});
  return result;
}

async function findRexWindow(rex, session, id) {
  const result = await rexJson(rex, ["window", "ls", "-s", session.session_id, "--json"]);
  const window = (result.windows || []).find((item) => item.label === `pi:${id}`);
  if (!window) return null;
  const blocks = (window.layers || []).flatMap((layer) => layer.blocks || []);
  for (const block of blocks) {
    if (block.creator_name !== "com.superlogical.terminal") continue;
    const processInfo = await rexJson(rex, ["block", "call", "-s", session.session_id, "-b", block.block_id, "process"]);
    if (processInfo.last_exit === null) return window.window_id;
  }
  return null;
}

async function openInRex(settings, file, id, cwd) {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const rex = findRexExecutable();
  const session = await findVaultSession(rex);
  const liveWindow = session && await findRexWindow(rex, session, id);
  const target = liveWindow
    ? { sessionId: session.session_id, windowId: liveWindow }
    : await createRexWindow(settings, rex, id, cwd, ["--session", file]);
  await showInRex(rex, target.sessionId, target.windowId);
  return liveWindow ? "Focused the Pi session in Rex." : "Opened the Pi session in Rex.";
}

function openButtonLabel(settings) {
  if (settings.buttonLabel.trim()) return settings.buttonLabel.trim();
  return settings.openTarget === "rex" ? "Open in Rex" : "Open session";
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
      .setName("Pi executable")
      .setDesc("Absolute path to Pi. Leave empty to detect Pi from PATH and common install locations.")
      .addText((text) => text
        .setPlaceholder(detectPiExecutable() || "Auto-detect")
        .setValue(settings.piExecutable)
        .onChange(async (value) => {
          settings.piExecutable = value;
          await this.plugin.saveSettings();
        }));

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
        .addOption("rex", "Rex")
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

    if (settings.openTarget === "rex") return;

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
    this.openingSessions = new Set();
    if (this.settings.openTarget === "herdr-app") this.settings.openTarget = "rex";
    this.addSettingTab(new PiSessionSettingsTab(this.app, this));
    this.addCommand({
      id: "start-pi-session",
      name: "Start Pi session from selection",
      editorCheckCallback: (checking, editor, view) => {
        if (!editor.getSelection().trim()) return false;
        if (!checking) this.startSession(editor, view);
        return true;
      },
    });

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
        if (this.openingSessions.has(id)) return;
        this.openingSessions.add(id);
        btn.disabled = true;
        try {
          const result = this.settings.openTarget === "custom-command"
            ? await openWithCustomCommand(this.settings, file, id, s.cwd)
            : await openInRex(this.settings, file, id, s.cwd);
          new Notice(result);
        } catch (e) {
          new Notice(`Pi Session: ${e.message}`, 8000);
        } finally {
          this.openingSessions.delete(id);
          btn.disabled = false;
        }
      });
    });
  }

  async startSession(editor, view) {
    if (this.launching) {
      new Notice("Pi Session: A session launch is in progress.");
      return;
    }
    const prompt = editor.getSelection();
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const original = editor.getValue();
    const file = view.file;
    if (prompt.includes("\0")) {
      new Notice("Pi Session: The selection contains a null character.");
      return;
    }
    this.launching = true;
    const id = randomUUID();
    let attempted = false;
    try {
      const rex = findRexExecutable();
      // Pi treats an argument that starts with @ as a file, even after --.
      const argument = prompt.startsWith("@") ? ` ${prompt}` : prompt;
      attempted = true;
      const target = await createRexWindow(this.settings, rex, id, HOME, ["--session-id", id, "--", argument]);
      showInRex(rex, target.sessionId, target.windowId).catch((error) => new Notice(`Pi Session: ${error.message}`, 8000));
      let sessionFile;
      for (let i = 0; i < 300; i++) {
        sessionFile = findSessionFile(id);
        if (sessionFile && parseSession(sessionFile).users > 0) break;
        sessionFile = null;
        await sleep(200);
      }
      if (!sessionFile) throw new Error(`Pi did not save the prompt. Session ID: ${id}`);
      if (view.file !== file || editor.getValue() !== original) {
        throw new Error(`The note changed. The selection was not replaced. Session ID: ${id}`);
      }
      const before = editor.getLine(from.line).slice(0, from.ch);
      const after = editor.getLine(to.line).slice(to.ch);
      const block = `${before ? "\n" : ""}\`\`\`pi-session\n${id}\n\`\`\`${after ? "\n" : ""}`;
      editor.replaceRange(block, from, to);
      new Notice("Pi session started in Rex.");
    } catch (error) {
      const recovery = attempted && !error.message.includes(id) ? ` Check Rex before retry. Session ID: ${id}` : "";
      new Notice(`Pi Session: ${error.message}${recovery}`, 12000);
    } finally {
      this.launching = false;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
