const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const ID = "12345678-1234-4234-8234-123456789abc";
const SOURCE = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function fakeEl(tag = "div", options = {}) {
  return {
    tag, cls: options.cls || "", text: options.text || "", attr: options.attr || {}, children: [], isConnected: true,
    createDiv(o) { return this.createEl("div", o); },
    createEl(t, o = {}) { const child = fakeEl(t, o); this.children.push(child); return child; },
    setText(text) { this.text = text; },
    empty() { this.children = []; },
    addEventListener(name, callback) { this[name] = callback; },
  };
}

const texts = (el) => [el.text, ...el.children.flatMap(texts)].filter(Boolean);

function writeSession(home) {
  const dir = path.join(home, ".pi", "agent", "sessions", "--home--");
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", cwd: home, timestamp: "2026-01-01T00:00:00Z" },
    { type: "session_info", name: "fix the test" },
    { type: "message", message: { role: "user", content: "first prompt" } },
    { type: "message", message: { role: "assistant", model: "m", content: "last reply" } },
  ];
  fs.writeFileSync(path.join(dir, `test_${ID}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function fixture(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-pi-test-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  for (const name of ["rex", "pi"]) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
  const calls = [];
  const notices = [];
  const sessionDir = path.join(home, ".pi", "agent", "sessions", "--home--");
  const sessions = [...(options.sessions ?? [{ label: "vault", session_id: "session:vault" }])];
  const windowsBySession = options.windowsBySession || { "session:vault": [...(options.windows || [])] };
  const server = "unix:///test/rex.sock";
  const livePids = new Set(options.livePids || [42]);
  const createRecord = (sessionId, blockId, id = ID, pid = 42, serverId = server) => {
    const dir = path.join(home, ".cache", "pi-rex-session-label");
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.createHash("sha256").update(JSON.stringify([serverId, sessionId, blockId])).digest("hex");
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ version: 1, pid, token: "test-token", previous: "shell", label: `pi:${id}` }));
  };
  const blocksFor = (sessionId) => [
    ...(windowsBySession[sessionId] || []).flatMap((window) => (window.layers || []).flatMap((layer) => layer.blocks || []).map((block) => ({ placement: "placed", host_id: "host:local", window_id: window.window_id, ...block }))),
    ...((options.detached || {})[sessionId] || []),
  ];

  class Plugin {
    async loadData() { return options.settings || {}; }
    async saveData(data) { this.saved = JSON.parse(JSON.stringify(data)); }
    addSettingTab() {}
    addCommand(command) { this.commands = { ...this.commands, [command.id]: command }; if (!this.command) this.command = command; }
    registerMarkdownCodeBlockProcessor(name, processor) { this.processor = processor; }
  }
  class Notice { constructor(text) { notices.push(text); } }
  class PluginSettingTab {}
  class Setting {}

  function execFile(command, args, opts, callback) {
    calls.push({ command, args: Array.from(args) });
    let result = {};
    if (args[0] === "ls") {
      result = { sessions };
    } else if (args[0] === "whoami") {
      result = { endpoint: server, host_id: "host:local" };
    } else if (args[0] === "window" && args[1] === "ls") {
      result = { windows: windowsBySession[args[3]] || [] };
    } else if (args[0] === "block" && args[1] === "ls") {
      if (options.onBlockList) options.onBlockList(windowsBySession, args[3]);
      result = { blocks: blocksFor(args[3]) };
    } else if (args[0] === "block" && args[1] === "call") {
      const blockId = args[args.indexOf("-b") + 1];
      result = options.processByBlock?.[blockId] || { last_exit: options.lastExit ?? null, foreground: { pid: 42, argv0: "pi" } };
    } else if (args[0] === "new" || (args[0] === "window" && args[1] === "new")) {
      if (options.failLaunch) return callback(new Error("launch failed"), "", "launch failed");
      const marker = args.indexOf("--session-id");
      if (marker !== -1 && options.savePrompt !== false) {
        fs.mkdirSync(sessionDir, { recursive: true });
        const message = { type: "message", message: { role: "user", content: args[marker + 3] } };
        const entries = options.name ? [{ type: "session_info", name: options.name }, message] : [message];
        fs.writeFileSync(path.join(sessionDir, `test_${ID}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      }
      const sessionId = args[0] === "new" ? "session:new" : args[3];
      if (args[0] === "new") sessions.push({ label: "vault", session_id: sessionId });
      const block = { creator_name: "com.superlogical.terminal", block_id: "block:new", label: options.labelNewBlock === false ? "shell" : `pi:${ID}` };
      (windowsBySession[sessionId] ||= []).push({ label: `pi:${ID}`, window_id: "window:new", layers: [{ blocks: [block] }] });
      if (options.labelNewBlock !== false) createRecord(sessionId, "block:new");
      if (options.afterLaunch) options.afterLaunch();
      result = args[0] === "new"
        ? { session_id: sessionId, initial_windows: [{ window_id: "window:new", block_ids: ["block:new"] }] }
        : { window_id: "window:new", block_ids: ["block:new"] };
    } else if (args[0] === "client") {
      const app = { client_id: "client:app", info: { kind: "app" }, connection_state: "connected" };
      const connected = options.appConnected ? options.appConnected(calls) : true;
      result = { clients: connected ? [app] : [] };
    } else if (command === "/usr/bin/osascript" && options.failActivate) {
      return callback(new Error("not allowed"), "", "not allowed");
    } else if (args[0] === "-C" && options.failSelect) {
      return callback(new Error("Remote Control is off"), "", "Remote Control is off");
    }
    callback(null, JSON.stringify(result), "");
  }

  const context = {
    module: { exports: {} },
    process: { env: { PATH: bin }, platform: options.platform || "linux", kill(pid) { if (!livePids.has(pid)) { const error = new Error("no process"); error.code = "ESRCH"; throw error; } } },
    setTimeout: (callback) => { if (options.onTimeout) options.onTimeout(sessionDir); setImmediate(callback); },
    require(name) {
      if (name === "obsidian") return { Plugin, PluginSettingTab, Setting, Notice };
      if (name === "os") return { homedir: () => home };
      if (name === "child_process") return { execFile };
      if (name === "crypto") return { ...crypto, randomUUID: () => ID };
      return require(name);
    },
  };
  vm.runInNewContext(`${SOURCE}\nmodule.exports.testHelpers = { openInRex, findVaultSession };`, context);
  const PluginClass = context.module.exports;
  const plugin = new PluginClass();
  const editor = {
    text: "before prompt after",
    selection: "prompt",
    getSelection() { return this.selection; },
    getCursor(which) { return which === "from" ? { line: 0, ch: 7 } : { line: 0, ch: 13 }; },
    getValue() { return this.text; },
    getLine() { return this.text; },
    replaceRange(value, from, to) { this.text = this.text.slice(0, from.ch) + value + this.text.slice(to.ch); },
  };
  return { home, bin, calls, notices, plugin, editor, createRecord, helpers: PluginClass.testHelpers,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("starts Pi in the vault tab and replaces the selection after the prompt is saved", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  await f.plugin.onload();
  assert.equal(f.plugin.command.editorCheckCallback(true, f.editor, {}), true);
  await f.plugin.startSession(f.editor, { file: {} });
  const launch = f.calls.find(({ args }) => args[0] === "window" && args[1] === "new");
  assert.deepEqual(launch.args, ["window", "new", "-s", "session:vault", `pi:${ID}`, "-c", f.home, "--json", "--", path.join(f.bin, "pi"), "--session-id", ID, "--", "prompt"]);
  assert.equal(f.editor.text, `before \n\`\`\`pi-session\n${ID}\n\`\`\`\n after`);
  assert.ok(f.notices.includes("Pi session started in Rex."));
});

test("creates the vault session when it does not exist", async (t) => {
  const f = fixture({ sessions: [] }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  const launch = f.calls.find(({ args }) => args[0] === "new");
  assert.deepEqual(launch.args.slice(0, 7), ["new", "vault", "-c", f.home, "--window", `pi:${ID}`, "--json"]);
  assert.ok(f.editor.text.includes(ID));
});

test("keeps the selection when Pi does not save the prompt", async (t) => {
  const f = fixture({ savePrompt: false }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.editor.text, "before prompt after");
  assert.ok(f.notices.some((notice) => notice.includes(`Pi did not save the prompt. Session ID: ${ID}`)));
});

test("keeps edits made while Pi starts", async (t) => {
  let editor;
  const f = fixture({ afterLaunch: () => { editor.text = "changed"; } }); t.after(f.cleanup);
  editor = f.editor;
  await f.plugin.onload();
  await f.plugin.startSession(editor, { file: {} });
  assert.equal(editor.text, "changed");
  assert.ok(f.notices.some((notice) => notice.includes(`The note changed. The selection was not replaced. Session ID: ${ID}`)));
});

test("keeps the selection when Rex fails", async (t) => {
  const f = fixture({ failLaunch: true }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.editor.text, "before prompt after");
  assert.ok(f.notices.some((notice) => notice.includes("launch failed") && notice.includes(`Session ID: ${ID}`)));
});

test("passes special text as one argument and avoids Pi's @file syntax", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  await f.plugin.onload();
  f.editor.selection = "@mention\n$(echo unsafe)";
  await f.plugin.startSession(f.editor, { file: {} });
  const launch = f.calls.find(({ args }) => args[0] === "window" && args[1] === "new");
  assert.equal(launch.args.at(-1), " @mention\n$(echo unsafe)");
});

test("focuses a live Pi pane in another Rex session, even if its cwd is gone", async (t) => {
  const sessions = [{ label: "other", session_id: "session:other" }];
  const windowsBySession = { "session:other": [{ label: "original tab", window_id: "window:live", layers: [{ blocks: [
    { creator_name: "com.superlogical.terminal", block_id: "block:shell", label: "shell" },
    { creator_name: "com.superlogical.terminal", block_id: "block:live", label: `pi:${ID}` },
  ] }] }] };
  const f = fixture({ sessions, windowsBySession, settings: { piExecutable: "/missing/pi" } }); t.after(f.cleanup);
  f.createRecord("session:other", "block:live");
  await f.plugin.onload();
  const result = await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, "/missing", "new name");
  assert.equal(result, "Focused the Pi session in Rex.");
  assert.equal(f.calls.some(({ args }) => args[1] === "new" || args[1] === "rename"), false);
  assert.ok(f.calls.some(({ args }) => args.join(" ") === "focus -s session:other block:live"));
  assert.ok(f.calls.some(({ args }) => args.includes("session_id=session:other") && args.includes("window_id=window:live")));
});

test("waits for the Pi session name before it names the Rex tab", async (t) => {
  let polls = 0;
  const f = fixture({ onTimeout(dir) {
    const file = path.join(dir, `test_${ID}.jsonl`);
    if (++polls === 5 && fs.existsSync(file)) fs.appendFileSync(file, JSON.stringify({ type: "session_info", name: "Late name" }) + "\n");
  } }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  const rename = f.calls.find(({ args }) => args[0] === "window" && args[1] === "rename")?.args;
  assert.deepEqual(rename, ["window", "rename", "-s", "session:vault", "--", "window:new", "Late name"]);
  assert.ok(f.editor.text.includes(ID));
});

test("inserts the card without a name after the name wait ends", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.calls.find(({ args }) => args[1] === "rename"), undefined);
  assert.ok(f.editor.text.includes(ID));
});

test("names a new Rex tab only after the extension labels its block", async (t) => {
  const f = fixture({ name: "  -fix   the flaky checkout test in the storefront suite" }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  const rename = (kind) => f.calls.find(({ args }) => args[0] === kind && args[1] === "rename")?.args;
  assert.equal(rename("block"), undefined);
  assert.deepEqual(rename("window"), ["window", "rename", "-s", "session:vault", "--", "window:new", "-fix the flaky checkout test in the s..."]);
});

test("keeps the initial window ID if the extension has not labeled the block", async (t) => {
  const f = fixture({ name: "A name", labelNewBlock: false }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.calls.some(({ args }) => args[1] === "rename"), false);
});

test("names a new tab when the extension labels the block after startup", async (t) => {
  let reads = 0;
  const f = fixture({ name: "A name", labelNewBlock: false, onBlockList(windows, session) {
    if (++reads === 2) windows[session][0].layers[0].blocks[0].label = `pi:${ID}`;
  } }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.ok(f.calls.some(({ args }) => args.join(" ") === "window rename -s session:vault -- window:new A name"));
});

test("does not overwrite a tab name set during startup", async (t) => {
  const f = fixture({ name: "A name", onBlockList(windows, session) {
    windows[session][0].label = "user name";
  } }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.calls.some(({ args }) => args[1] === "rename"), false);
});

test("keeps the ID label when the Pi session has no name", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.calls.some(({ args }) => args[1] === "rename"), false);
});

test("focuses the labeled pane when its old window label matches and another pane is a shell", async (t) => {
  const windows = [{ label: `pi:${ID}`, window_id: "window:live", layers: [{ blocks: [
    { creator_name: "com.superlogical.terminal", block_id: "block:live", label: `pi:${ID}` },
    { creator_name: "com.superlogical.terminal", block_id: "block:shell", label: "shell" },
  ] }] }];
  const f = fixture({ windows }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:live");
  await f.plugin.onload();
  assert.equal(await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), "Focused the Pi session in Rex.");
  assert.ok(f.calls.some(({ args }) => args.join(" ") === "focus -s session:vault block:live"));
});

test("refuses an unverified labeled shell rather than opening a second writer", async (t) => {
  const windows = [{ label: "tab", window_id: "window:live", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:live", label: `pi:${ID}` }] }] }];
  const f = fixture({ windows }); t.after(f.cleanup);
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /Cannot verify/);
  assert.equal(f.calls.some(({ args }) => args[1] === "new"), false);
});

test("reopens a session when the local record's Pi process no longer exists", async (t) => {
  const windows = [{ label: "tab", window_id: "window:old", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:old", label: `pi:${ID}` }] }] }];
  const f = fixture({ windows, livePids: [], processByBlock: { "block:old": { last_exit: null, foreground: { pid: 50, argv0: "zsh" } } } }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:old");
  await f.plugin.onload();
  assert.equal(await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), "Opened the Pi session in Rex.");
  assert.ok(f.calls.some(({ args }) => args.includes("--session") && args.includes("/session.jsonl")));
});

test("refuses a live journal PID that Rex cannot associate with the pane", async (t) => {
  const windows = [{ label: "tab", window_id: "window:old", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:old", label: `pi:${ID}` }] }] }];
  const f = fixture({ windows, processByBlock: { "block:old": { last_exit: null, foreground: { pid: 50, argv0: "zsh" } } } }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:old");
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /Cannot verify/);
  assert.equal(f.calls.some(({ args }) => args[1] === "new"), false);
});

test("accepts Pi as an ancestor of the foreground process", async (t) => {
  const windows = [{ label: "tab", window_id: "window:live", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:live", label: `pi:${ID}` }] }] }];
  const f = fixture({ windows, processByBlock: { "block:live": { last_exit: null, foreground: { pid: 50, argv0: "bash" }, ancestors: [{ pid: 42, argv0: "pi" }] } } }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:live");
  await f.plugin.onload();
  assert.equal(await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), "Focused the Pi session in Rex.");
});

test("does not use local PID checks for a remote pane", async (t) => {
  const windows = [{ label: "tab", window_id: "window:old", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:old", label: `pi:${ID}`, host_id: "host:remote" }] }] }];
  const f = fixture({ windows, livePids: [], processByBlock: { "block:old": { last_exit: null, foreground: { pid: 50, argv0: "zsh" } } } }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:old");
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /Cannot verify/);
  assert.equal(f.calls.some(({ args }) => args[1] === "new"), false);
});

test("refuses a legacy tab whose process may still be Pi", async (t) => {
  const windows = [{ label: `pi:${ID}`, window_id: "window:old", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:old", label: "shell" }] }] }];
  const f = fixture({ windows }); t.after(f.cleanup);
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /may already contain/);
  assert.equal(f.calls.some(({ args }) => args[1] === "new"), false);
});

test("refuses duplicate labels across Rex sessions", async (t) => {
  const pane = (id) => [{ label: "tab", window_id: `window:${id}`, layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: `block:${id}`, label: `pi:${ID}` }] }] }];
  const f = fixture({ sessions: [{ label: "a", session_id: "session:a" }, { label: "b", session_id: "session:b" }], windowsBySession: { "session:a": pane("a"), "session:b": pane("b") } }); t.after(f.cleanup);
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /More than one Rex pane/);
  assert.equal(f.calls.some(({ args }) => args[1] === "new"), false);
});

test("does not focus a pane after Pi switches to another session", async (t) => {
  const windows = [{ label: `pi:${ID}`, window_id: "window:old", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:old", label: "pi:other" }] }] }];
  const f = fixture({ windows }); t.after(f.cleanup);
  await f.plugin.onload();
  assert.equal(await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), "Opened the Pi session in Rex.");
  assert.equal(f.calls.some(({ args }) => args[0] === "focus" && args.includes("block:old")), false);
});

test("refuses a detached Pi pane", async (t) => {
  const f = fixture({ detached: { "session:vault": [{ creator_name: "com.superlogical.terminal", block_id: "block:detached", label: `pi:${ID}`, placement: "detached", host_id: "host:local" }] } }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:detached");
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /detached/);
});

test("coalesces concurrent opens for the same Pi session", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  await f.plugin.onload();
  const results = await Promise.all([f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home)]);
  assert.deepEqual(results, ["Opened the Pi session in Rex.", "Opened the Pi session in Rex."]);
  assert.equal(f.calls.filter(({ args }) => args[0] === "window" && args[1] === "new").length, 1);
});

test("refuses a shared lock from another Obsidian instance", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const dir = path.join(f.home, ".cache", "obsidian-pi-session", "open-locks");
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash("sha256").update(`session:${ID}`).digest("hex");
  const lock = path.join(dir, `${key}.lock`);
  fs.writeFileSync(lock, JSON.stringify({ token: "other" }));
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /Another open request/);
  assert.ok(fs.existsSync(lock));
  assert.equal(f.calls.some(({ args }) => args[1] === "new"), false);
});

test("releases the shared lock when Rex cannot select the tab", async (t) => {
  const windows = [{ label: "tab", window_id: "window:live", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:live", label: `pi:${ID}` }] }] }];
  const f = fixture({ windows, failSelect: true }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:live");
  await f.plugin.onload();
  await assert.rejects(f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home), /Remote Control/);
  assert.deepEqual(fs.readdirSync(path.join(f.home, ".cache", "obsidian-pi-session", "open-locks")), []);
  assert.equal(f.calls.some(({ args }) => args[1] === "new"), false);
});

test("the card button focuses the labeled pane", async (t) => {
  const windows = [{ label: "tab", window_id: "window:live", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:live", label: `pi:${ID}` }] }] }];
  const f = fixture({ windows }); t.after(f.cleanup);
  f.createRecord("session:vault", "block:live");
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  const button = el.children[0].children.at(-1).children.find((child) => child.tag === "button");
  await button.click();
  assert.ok(f.calls.some(({ args }) => args.join(" ") === "focus -s session:vault block:live"));
  assert.ok(f.notices.includes("Focused the Pi session in Rex."));
});

test("reopens a Pi tab after its process exits", async (t) => {
  const windows = [{ label: `pi:${ID}`, window_id: "window:old", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:old" }] }] }];
  const f = fixture({ windows, lastExit: { code: 0 } }); t.after(f.cleanup);
  await f.plugin.onload();
  const result = await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home);
  assert.equal(result, "Opened the Pi session in Rex.");
  assert.ok(f.calls.some(({ args }) => args.includes("--session") && args.includes("/session.jsonl")));
});

const ACTIVATE = ["-e", 'tell application id "com.superlogical.rex" to activate'];
const appSteps = (calls) => calls
  .filter(({ command, args }) => command === "/usr/bin/osascript" || command === "/usr/bin/open" || args[0] === "focus" || args[0] === "-C")
  .map(({ command, args }) => command === "/usr/bin/osascript" ? "activate" : command === "/usr/bin/open" ? "open" : args[0] === "focus" ? "focus" : "select");

test("selects the Rex tab before it activates Rex with AppleScript", async (t) => {
  const f = fixture({ platform: "darwin" }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home);
  assert.deepEqual(appSteps(f.calls), ["focus", "select", "activate"]);
  assert.deepEqual(f.calls.find(({ command }) => command === "/usr/bin/osascript").args, ACTIVATE);
});

test("activates Rex, waits for the app, selects the tab, and activates Rex again", async (t) => {
  const f = fixture({ platform: "darwin", appConnected: (calls) => calls.some(({ command }) => command === "/usr/bin/osascript") }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home);
  assert.deepEqual(appSteps(f.calls), ["focus", "activate", "select", "activate"]);
});

test("does not activate Rex outside macOS", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  await f.plugin.onload();
  await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home);
  assert.deepEqual(appSteps(f.calls), ["focus", "select"]);
});

test("reports a missing Rex app and a denied activation", async (t) => {
  const a = fixture({ appConnected: () => false }); t.after(a.cleanup);
  await a.plugin.onload();
  await assert.rejects(a.helpers.openInRex(a.plugin.settings, "/session.jsonl", ID, a.home), /Rex app did not connect/);
  const b = fixture({ platform: "darwin", failActivate: true }); t.after(b.cleanup);
  await b.plugin.onload();
  await assert.rejects(b.helpers.openInRex(b.plugin.settings, "/session.jsonl", ID, b.home), /Allow Obsidian to control Rex/);
});

test("rejects duplicate vault session labels", async (t) => {
  const f = fixture({ sessions: [{ label: "vault" }, { label: "vault" }] }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.editor.text, "before prompt after");
  assert.ok(f.notices.some((notice) => notice.includes("More than one Rex session")));
});

test("renders the default card with metadata and the last reply", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(`${ID}\n`, el);
  const shown = texts(el);
  assert.equal(el.children[0].cls, "pi-session-card");
  for (const text of ["fix the test", "First prompt", "first prompt", "Last reply", "last reply", ID, "Open in Rex"]) assert.ok(shown.includes(text), text);
  assert.ok(shown.some((text) => text.includes("1 user / 1 assistant")));
});

test("renders the compact card with the title, prompt, start time, message count, ID, and button only", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact" } }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  assert.equal(el.children[0].cls, "pi-session-card pi-session-compact");
  const start = new Date("2026-01-01T00:00:00Z").toLocaleString();
  assert.deepEqual(texts(el), ["fix the test", "first prompt", `${start}  ·  2 messages`, ID, "Open in Rex"]);
  const prompt = el.children[0].children[1];
  assert.equal(prompt.cls, "pi-session-prompt");
  assert.equal(prompt.attr.title, "first prompt");
});

test("cuts the compact prompt to 300 characters and keeps the full prompt in the tooltip", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact" } }); t.after(f.cleanup);
  writeSession(f.home);
  const long = "x".repeat(400);
  const file = path.join(f.home, ".pi", "agent", "sessions", "--home--", `test_${ID}.jsonl`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("first prompt", long));
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  const prompt = el.children[0].children[1];
  assert.equal(prompt.text, `${"x".repeat(300)}...`);
  assert.equal(prompt.attr.title, long);
});

test("refreshes cards from the command and reads the session file again", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact" } }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  const file = path.join(f.home, ".pi", "agent", "sessions", "--home--", `test_${ID}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: "session_info", name: "renamed" }) + "\n");
  await f.plugin.commands["refresh-pi-session-cards"].callback();
  assert.equal(texts(el)[0], "renamed");
  assert.ok(f.notices.includes("Refreshed 1 Pi session card. Updated 0 titles from Rex."));
});

const piTab = (label, blockLabels) => ({
  label, window_id: `window:${label}`,
  layers: [{ blocks: blockLabels.map((blockLabel, i) => ({ creator_name: "com.superlogical.terminal", block_id: `block:${label}:${i}`, label: blockLabel })) }],
});

test("shows the Rex tab name on the card after a refresh and keeps it after the tab closes", async (t) => {
  const windows = [piTab("Checkout fix", [`pi:${ID}`])];
  const f = fixture({ settings: { cardLayout: "compact" }, windows }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  assert.equal(texts(el)[0], "fix the test");
  await f.plugin.commands["refresh-pi-session-cards"].callback();
  assert.equal(texts(el)[0], "Checkout fix");
  assert.deepEqual(f.plugin.saved.tabNames, { [ID]: "Checkout fix" });
  assert.ok(f.notices.includes("Refreshed 1 Pi session card. Updated 1 title from Rex."));
  windows.length = 0;
  await f.plugin.commands["refresh-pi-session-cards"].callback();
  assert.equal(texts(el)[0], "Checkout fix");
});

test("ignores default Rex tab names, plugin labels, and tabs with more than one Pi pane", async (t) => {
  const windows = [piTab("Window 635b87d7", [`pi:${ID}`]), piTab(`pi:${ID}`, [`pi:${ID}`]), piTab("Two panes", [`pi:${ID}`, "pi:other"]), piTab("Shell only", ["shell"])];
  const f = fixture({ settings: { cardLayout: "compact" }, windows }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  await f.plugin.commands["refresh-pi-session-cards"].callback();
  assert.equal(texts(el)[0], "fix the test");
  assert.equal(f.plugin.saved, undefined);
});

test("refreshes cards when Rex is not available", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact" } }); t.after(f.cleanup);
  writeSession(f.home);
  fs.rmSync(path.join(f.bin, "rex"));
  await f.plugin.onload();
  f.plugin.processor(ID, fakeEl());
  await f.plugin.commands["refresh-pi-session-cards"].callback();
  assert.ok(f.notices.some((notice) => notice.startsWith("Refreshed 1 Pi session card. Could not read Rex tab names.")));
});

test("opens a new Rex tab with the card title and saves the tab name", async (t) => {
  const f = fixture({ settings: { tabNames: { [ID]: "Saved tab name" } } }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  assert.equal(texts(el)[0], "Saved tab name");
  const button = el.children[0].children.at(-1).children.at(-1);
  await button.click();
  const rename = f.calls.find(({ args }) => args[0] === "window" && args[1] === "rename")?.args;
  assert.equal(rename.at(-1), "Saved tab name");
});

test("shows the title from the block before the Rex tab name and the session name", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact", tabNames: { [ID]: "Saved tab name" } } }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  for (const source of [`title: exploration\n${ID}\n`, `${ID}\n  Title :  exploration  \n`]) {
    const el = fakeEl();
    f.plugin.processor(source, el);
    assert.equal(texts(el)[0], "exploration");
    assert.ok(texts(el).includes(ID));
  }
  const empty = fakeEl();
  f.plugin.processor(`title:\n${ID}`, empty);
  assert.equal(texts(empty)[0], "Saved tab name");
});

test("reads the ID from an id key or a bare line", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact" } }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const sources = [
    `${ID}`,
    `id: ${ID}`,
    `title: exploration\nid: ${ID}`,
    `ID :  ${ID}  \ntitle: exploration`,
    `id: ${ID}\nother line`,
    `unknown: value\n${ID}`,
  ];
  for (const source of sources) {
    const el = fakeEl();
    f.plugin.processor(source, el);
    assert.equal(el.children[0].children.at(-1).children[0].text, ID, source);
  }
  const missing = fakeEl();
  f.plugin.processor("title: exploration", missing);
  assert.equal(texts(missing)[0], "Session not found: ");
});

test("keeps the block title after a refresh and uses it for a new Rex tab", async (t) => {
  const f = fixture({ windows: [piTab("Rex name", ["shell"])] }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(`title: exploration\n${ID}`, el);
  await f.plugin.commands["refresh-pi-session-cards"].callback();
  assert.equal(texts(el)[0], "exploration");
  await el.children[0].children.at(-1).children.at(-1).click();
  const rename = f.calls.find(({ args }) => args[0] === "window" && args[1] === "rename")?.args;
  assert.equal(rename.at(-1), "exploration");
});

test("saves the Rex tab name after it starts a session", async (t) => {
  const f = fixture({ name: "A name" }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.deepEqual(f.plugin.saved.tabNames, { [ID]: "A name" });
});

test("re-renders connected cards when the layout changes", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const live = fakeEl();
  const gone = fakeEl();
  f.plugin.processor(ID, live);
  f.plugin.processor(ID, gone);
  gone.isConnected = false;
  f.plugin.settings.cardLayout = "compact";
  f.plugin.refreshCards();
  assert.equal(live.children[0].cls, "pi-session-card pi-session-compact");
  assert.equal(gone.children[0].cls, "pi-session-card");
  assert.equal(f.plugin.cards.size, 1);
});

test("migrates the Herdr target and preserves the custom target", async (t) => {
  const a = fixture({ settings: { openTarget: "herdr-app" } }); t.after(a.cleanup);
  const b = fixture({ settings: { openTarget: "custom-command" } }); t.after(b.cleanup);
  await a.plugin.onload(); await b.plugin.onload();
  assert.equal(a.plugin.settings.openTarget, "rex");
  assert.equal(b.plugin.settings.openTarget, "custom-command");
});
