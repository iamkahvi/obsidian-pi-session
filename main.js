const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { createHash, randomUUID } = require("crypto");

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, ".pi", "agent", "sessions");
const MAX_CHARS = 300;
const MAX_TAB_CHARS = 40;
const NAME_WAIT_POLLS = 50; // 10 seconds at 200 ms
const DEFAULT_SETTINGS = {
  cardLayout: "default",
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

async function showInRex(rex, sessionId, windowId, blockId) {
  if (blockId) await run(rex, ["focus", "-s", sessionId, blockId]);
  if (process.platform === "darwin") await run("/usr/bin/open", ["-b", REX_APP_BUNDLE]);
  for (let i = 0; i < 50; i++) {
    const { clients } = await rexJson(rex, ["client", "ls", "--json"]);
    const apps = (clients || []).filter((client) => client.info?.kind === "app" && client.connection_state === "connected");
    if (apps.length > 1) throw new Error("More than one Rex app is connected. Select the session in Rex.");
    if (apps.length === 1) {
      try {
        await run(rex, ["-C", apps[0].client_id, "do", "session.select", `session_id=${sessionId}`, `window_id=${windowId}`]);
      } catch (error) {
        throw new Error(`Could not select the Rex tab. Check Rex Remote Control. ${error.message}`);
      }
      return;
    }
    await sleep(200);
  }
  throw new Error("Rex app did not connect. Select the session in Rex.");
}

const piLabel = (id) => `pi:${id}`;

function tabLabel(name) {
  const clean = (name || "").replace(/\s+/g, " ").trim();
  return clean.length > MAX_TAB_CHARS ? `${clean.slice(0, MAX_TAB_CHARS - 3)}...` : clean;
}

// Rex gives new tabs names such as "Window 635b87d7".
const DEFAULT_TAB_NAME = /^Window [0-9a-f]{8}$/;

// Map each Pi session ID to the name of its Rex tab. Skip default names and tabs with more than one Pi pane.
async function listRexTabNames(rex) {
  const { sessions } = await rexJson(rex, ["ls", "--json"]);
  if (!Array.isArray(sessions)) throw new Error("Could not list Rex sessions.");
  const names = new Map();
  await Promise.all(sessions.map(async (session) => {
    const [{ windows }, { blocks }] = await Promise.all([
      rexJson(rex, ["window", "ls", "-s", session.session_id, "--json"]),
      rexJson(rex, ["block", "ls", "-s", session.session_id, "--json"]),
    ]);
    for (const window of windows || []) {
      const label = (window.label || "").trim();
      if (!label || label.startsWith("pi:") || DEFAULT_TAB_NAME.test(label)) continue;
      const ids = (blocks || [])
        .filter((block) => block.window_id === window.window_id && block.creator_name === "com.superlogical.terminal" && block.label?.startsWith("pi:"))
        .map((block) => block.label.slice(3));
      if (ids.length === 1) names.set(ids[0], label);
    }
  }));
  return names;
}

// Keep the initial window ID label until the Pi extension labels the block.
// Return the tab name when the rename succeeds.
async function nameRexWindow(rex, target, name) {
  const label = tabLabel(name);
  if (!label || !target.blockId) return null;
  try {
    for (let i = 0; i < 10; i++) {
      const { blocks } = await rexJson(rex, ["block", "ls", "-s", target.sessionId, "--json"]);
      const block = (blocks || []).find((item) => item.block_id === target.blockId);
      if (!block || (block.label?.startsWith("pi:") && block.label !== piLabel(target.id))) return;
      if (block.label === piLabel(target.id)) {
        const { windows } = await rexJson(rex, ["window", "ls", "-s", target.sessionId, "--json"]);
        if ((windows || []).some((item) => item.window_id === target.windowId && item.label === piLabel(target.id))) {
          await run(rex, ["window", "rename", "-s", target.sessionId, "--", target.windowId, label]);
          return label;
        }
        return null;
      }
      if (i < 9) await sleep(200);
    }
  } catch (error) {
    new Notice(`Pi Session: Could not name the Rex tab. ${error.message}`, 8000);
  }
}

let rexWindowQueue = Promise.resolve();

function createRexWindow(settings, rex, id, cwd, piArgs) {
  const create = async () => {
    const release = acquireOpenLock("vault-creation");
    try {
      const session = await findVaultSession(rex);
      const label = piLabel(id);
      const piCommand = [findPiExecutable(settings.piExecutable), ...piArgs];
      if (session) {
        const result = await rexJson(rex, ["window", "new", "-s", session.session_id, label, "-c", cwd, "--json", "--", ...piCommand]);
        return { id, sessionId: session.session_id, windowId: result.window_id, blockId: result.block_ids?.[0] };
      }
      const result = await rexJson(rex, ["new", REX_SESSION, "-c", cwd, "--window", label, "--json", "--", ...piCommand]);
      const window = result.initial_windows[0];
      return { id, sessionId: result.session_id, windowId: window.window_id, blockId: window.block_ids?.[0] };
    } finally {
      release();
    }
  };
  const result = rexWindowQueue.then(create);
  rexWindowQueue = result.catch(() => {});
  return result;
}

// The Pi extension owns this record. It associates a block label with the Pi PID.
function rexLabelRecord(server, sessionId, blockId, label) {
  const cache = process.env.XDG_CACHE_HOME || path.join(HOME, ".cache");
  const key = createHash("sha256").update(JSON.stringify([server, sessionId, blockId])).digest("hex");
  try {
    const record = JSON.parse(fs.readFileSync(path.join(cache, "pi-rex-session-label", `${key}.json`), "utf8"));
    if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.label !== label || typeof record.token !== "string") return null;
    return record;
  } catch {
    return null;
  }
}

async function findRexWindow(rex, id) {
  const { sessions } = await rexJson(rex, ["ls", "--json"]);
  if (!Array.isArray(sessions)) throw new Error("Could not list Rex sessions.");
  const matches = [];
  const legacy = [];
  for (const session of sessions) {
    const { blocks } = await rexJson(rex, ["block", "ls", "-s", session.session_id, "--json"]);
    const { windows } = await rexJson(rex, ["window", "ls", "-s", session.session_id, "--json"]);
    if (!Array.isArray(blocks) || !Array.isArray(windows)) throw new Error("Could not list Rex panes.");
    for (const block of blocks) {
      if (block.creator_name === "com.superlogical.terminal" && block.label === piLabel(id)) {
        matches.push({ id, sessionId: session.session_id, windowId: block.window_id, blockId: block.block_id, block });
      }
    }
    // Old plugin tabs and tabs whose Pi extension has not started yet.
    for (const window of windows.filter((item) => item.label === piLabel(id))) {
      if (blocks.some((item) => item.window_id === window.window_id && item.label === piLabel(id))) continue;
      for (const block of blocks.filter((item) => item.window_id === window.window_id && item.creator_name === "com.superlogical.terminal" && !item.label?.startsWith("pi:"))) {
        legacy.push({ sessionId: session.session_id, blockId: block.block_id });
      }
    }
  }
  if (matches.length > 1) throw new Error("More than one Rex pane has this Pi session ID. Check Rex before retry.");
  for (const candidate of legacy) {
    const info = await rexJson(rex, ["block", "call", "-s", candidate.sessionId, "-b", candidate.blockId, "process"]);
    if (info.last_exit === null || info.last_exit === undefined) throw new Error("A Rex tab may already contain this Pi session. Check Rex before retry.");
  }
  if (!matches.length) return null;

  const target = matches[0];
  const info = await rexJson(rex, ["block", "call", "-s", target.sessionId, "-b", target.blockId, "process"]);
  if (info.last_exit !== null && info.last_exit !== undefined) return null;
  const who = await rexJson(rex, ["whoami", "--json"]);
  const servers = [...new Set([process.env.REX_SERVER, who.endpoint, "default"].filter(Boolean))];
  const records = servers.map((server) => rexLabelRecord(server, target.sessionId, target.blockId, piLabel(id))).filter(Boolean);
  if (records.length !== 1) throw new Error("Cannot verify the Pi session in Rex. Check Rex before retry.");
  const record = records[0];
  const processes = [info.child, info.foreground, ...(info.ancestors || [])].filter(Boolean);
  const piProcess = processes.find((item) => item.pid === record.pid && (item.argv0 === "pi" || path.basename(item.script || "") === "pi"));
  if (piProcess && info.last_exit === null) {
    if (target.block.placement !== "placed" || !target.windowId) throw new Error("The Pi session is in a detached Rex pane. Attach it before retry.");
    return target;
  }
  // A local Unix server and a matching host ID make the journal PID local.
  if (who.endpoint?.startsWith("unix:") && who.host_id && target.block.host_id === who.host_id) {
    try { process.kill(record.pid, 0); }
    catch (error) { if (error.code === "ESRCH") return null; }
  }
  throw new Error("Cannot verify the Pi session in Rex. Check Rex before retry.");
}

const pendingRexOpens = new Map();

function acquireOpenLock(id) {
  const dir = path.join(HOME, ".cache", "obsidian-pi-session", "open-locks");
  const key = createHash("sha256").update(id).digest("hex");
  const file = path.join(dir, `${key}.lock`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another open request may be active. If it stopped, remove ${file} before retry.`);
    throw error;
  }
  const token = randomUUID();
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    fs.closeSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
    throw error;
  }
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

async function openInRex(settings, file, id, cwd, name, onTabName) {
  if (pendingRexOpens.has(id)) return pendingRexOpens.get(id);
  const open = (async () => {
    const release = acquireOpenLock(`session:${id}`);
    try {
      const rex = findRexExecutable();
      const liveWindow = await findRexWindow(rex, id);
      if (!liveWindow && (!cwd || !fs.existsSync(cwd))) throw new Error(`cwd does not exist: ${cwd}`);
      const target = liveWindow || await createRexWindow(settings, rex, id, cwd, ["--session", file]);
      if (!liveWindow) {
        const label = await nameRexWindow(rex, target, name);
        if (label && onTabName) await onTabName(label);
      }
      await showInRex(rex, target.sessionId, target.windowId, target.blockId);
      return liveWindow ? "Focused the Pi session in Rex." : "Opened the Pi session in Rex.";
    } finally {
      release();
    }
  })();
  pendingRexOpens.set(id, open);
  try { return await open; }
  finally { pendingRexOpens.delete(id); }
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

// A block holds "id:" and "title:" lines in any order. A bare line is the ID, for old blocks.
function parseBlock(source) {
  const keys = {};
  let bare = "";
  for (const line of source.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const match = line.match(/^([a-z]+)\s*:\s*(.*)$/i);
    if (match) keys[match[1].toLowerCase()] = match[2].trim();
    else if (!bare) bare = line;
  }
  return { id: keys.id || bare, title: keys.title || "" };
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
      .setName("Card layout")
      .setDesc("Compact shows only the title, first prompt, start time, message count, session ID, and button.")
      .addDropdown((dropdown) => dropdown
        .addOption("default", "Default")
        .addOption("compact", "Compact")
        .setValue(settings.cardLayout)
        .onChange(async (value) => {
          settings.cardLayout = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCards();
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
    this.settings.tabNames = { ...this.settings.tabNames };
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
    this.addCommand({
      id: "refresh-pi-session-cards",
      name: "Refresh Pi session cards and titles",
      callback: () => this.refreshFromRex(),
    });

    this.cards = new Set();
    this.registerMarkdownCodeBlockProcessor("pi-session", (source, el) => {
      const card = { el, ...parseBlock(source) };
      this.cards.add(card);
      this.renderCard(card);
    });
  }

  refreshCards() {
    for (const card of this.cards) {
      if (!card.el.isConnected) {
        this.cards.delete(card);
        continue;
      }
      card.el.empty();
      this.renderCard(card);
    }
    return this.cards.size;
  }

  renderCard({ el, id, title }) {
    const compact = this.settings.cardLayout === "compact";
    const card = el.createDiv({ cls: compact ? "pi-session-card pi-session-compact" : "pi-session-card" });
    const file = id && findSessionFile(id);
    if (!file) {
      card.createDiv({ cls: "pi-session-error", text: `Session not found: ${id}` });
      return;
    }
    const s = parseSession(file);
    card.createDiv({ cls: "pi-session-title", text: title || this.cardTitle(id, s) || "(no name)" });
    if (compact) {
      const prompt = s.firstUser.trim();
      if (prompt) card.createDiv({ cls: "pi-session-prompt", text: cut(prompt), attr: { title: prompt } });
      const messages = s.users + s.assistants;
      card.createDiv({
        cls: "pi-session-meta",
        text: [s.start && new Date(s.start).toLocaleString(), `${messages} message${messages === 1 ? "" : "s"}`]
          .filter(Boolean).join("  ·  "),
      });
    } else {
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
    }
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
          : await openInRex(this.settings, file, id, s.cwd, title || this.cardTitle(id, parseSession(file)), (label) => this.saveTabName(id, label));
        new Notice(result);
      } catch (e) {
        new Notice(`Pi Session: ${e.message}`, 8000);
      } finally {
        this.openingSessions.delete(id);
        btn.disabled = false;
      }
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
      showInRex(rex, target.sessionId, target.windowId, target.blockId).catch((error) => new Notice(`Pi Session: ${error.message}`, 8000));
      let sessionFile;
      for (let i = 0; i < 300; i++) {
        sessionFile = findSessionFile(id);
        if (sessionFile && parseSession(sessionFile).users > 0) break;
        sessionFile = null;
        await sleep(200);
      }
      if (!sessionFile) throw new Error(`Pi did not save the prompt. Session ID: ${id}`);
      let name = parseSession(sessionFile).name;
      for (let i = 0; !name && i < NAME_WAIT_POLLS; i++) {
        await sleep(200);
        name = parseSession(sessionFile).name;
      }
      const label = await nameRexWindow(rex, target, name);
      if (label) await this.saveTabName(id, label);
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

  // The Rex tab name wins over the Pi session name. The plugin keeps it after the tab closes.
  cardTitle(id, session) {
    return this.settings.tabNames[id] || session.name;
  }

  async saveTabName(id, label) {
    if (this.settings.tabNames[id] === label) return;
    this.settings.tabNames[id] = label;
    await this.saveSettings();
  }

  async refreshFromRex() {
    let message;
    try {
      const names = await listRexTabNames(findRexExecutable());
      let changed = 0;
      for (const [id, label] of names) {
        if (this.settings.tabNames[id] === label) continue;
        this.settings.tabNames[id] = label;
        changed++;
      }
      if (changed) await this.saveSettings();
      message = `Updated ${changed} title${changed === 1 ? "" : "s"} from Rex.`;
    } catch (error) {
      message = `Could not read Rex tab names. ${error.message}`;
    }
    const count = this.refreshCards();
    new Notice(`Refreshed ${count} Pi session card${count === 1 ? "" : "s"}. ${message}`);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
