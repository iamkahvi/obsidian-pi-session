const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ID = "12345678-1234-4234-8234-123456789abc";
const SOURCE = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function fakeEl(tag = "div", options = {}) {
  return {
    tag, cls: options.cls || "", text: options.text || "", children: [], isConnected: true,
    createDiv(o) { return this.createEl("div", o); },
    createEl(t, o = {}) { const child = fakeEl(t, o); this.children.push(child); return child; },
    setText(text) { this.text = text; },
    empty() { this.children = []; },
    addEventListener() {},
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

  class Plugin {
    async loadData() { return options.settings || {}; }
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
      result = { sessions: options.sessions ?? [{ label: "vault", session_id: "session:vault" }] };
    } else if (args[0] === "window" && args[1] === "ls") {
      result = { windows: options.windows || [] };
    } else if (args[0] === "block") {
      result = { last_exit: options.lastExit ?? null };
    } else if (args[0] === "new" || (args[0] === "window" && args[1] === "new")) {
      if (options.failLaunch) return callback(new Error("launch failed"), "", "launch failed");
      const marker = args.indexOf("--session-id");
      if (marker !== -1 && options.savePrompt !== false) {
        fs.mkdirSync(sessionDir, { recursive: true });
        const message = { type: "message", message: { role: "user", content: args[marker + 3] } };
        const entries = options.name ? [{ type: "session_info", name: options.name }, message] : [message];
        fs.writeFileSync(path.join(sessionDir, `test_${ID}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      }
      if (options.afterLaunch) options.afterLaunch();
      result = args[0] === "new"
        ? { session_id: "session:new", initial_windows: [{ window_id: "window:new", block_ids: ["block:new"] }] }
        : { window_id: "window:new", block_ids: ["block:new"] };
    } else if (args[0] === "client") {
      result = { clients: [{ client_id: "client:app", info: { kind: "app" }, connection_state: "connected" }] };
    }
    callback(null, JSON.stringify(result), "");
  }

  const context = {
    module: { exports: {} },
    process: { env: { PATH: bin }, platform: "linux" },
    setTimeout: (callback) => setImmediate(callback),
    require(name) {
      if (name === "obsidian") return { Plugin, PluginSettingTab, Setting, Notice };
      if (name === "os") return { homedir: () => home };
      if (name === "child_process") return { execFile };
      if (name === "crypto") return { randomUUID: () => ID };
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
  return { home, bin, calls, notices, plugin, editor, helpers: PluginClass.testHelpers,
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

test("focuses a live Pi tab rather than opening a second writer", async (t) => {
  const windows = [{ label: `pi:${ID}`, window_id: "window:live", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:live" }] }] }];
  const f = fixture({ windows }); t.after(f.cleanup);
  await f.plugin.onload();
  const result = await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home);
  assert.equal(result, "Focused the Pi session in Rex.");
  assert.equal(f.calls.some(({ args }) => args[0] === "window" && args[1] === "new"), false);
  assert.ok(f.calls.some(({ args }) => args.includes("window_id=window:live")));
});

test("names the Rex tab after the Pi session and keeps the ID on the block", async (t) => {
  const f = fixture({ name: "  -fix   the flaky checkout test in the storefront suite" }); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  const rename = (kind) => f.calls.find(({ args }) => args[0] === kind && args[1] === "rename")?.args;
  assert.deepEqual(rename("block"), ["block", "rename", "-s", "session:vault", "--", "block:new", `pi:${ID}`]);
  assert.deepEqual(rename("window"), ["window", "rename", "-s", "session:vault", "--", "window:new", "-fix the flaky checkout test in the s..."]);
});

test("keeps the ID label when the Pi session has no name", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  await f.plugin.onload();
  await f.plugin.startSession(f.editor, { file: {} });
  assert.equal(f.calls.some(({ args }) => args[1] === "rename"), false);
});

test("finds a live Pi tab by its block label", async (t) => {
  const windows = [
    { label: "other", window_id: "window:other", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:other", label: "shell" }] }] },
    { label: "readable name", window_id: "window:live", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:live", label: `pi:${ID}` }] }] },
  ];
  const f = fixture({ windows }); t.after(f.cleanup);
  await f.plugin.onload();
  const result = await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home, "new name");
  assert.equal(result, "Focused the Pi session in Rex.");
  assert.equal(f.calls.some(({ args }) => args[0] === "window" && args[1] === "new"), false);
  assert.ok(f.calls.some(({ args }) => args.join(" ") === "window rename -s session:vault -- window:live new name"));
  assert.ok(f.calls.some(({ args }) => args.includes("window_id=window:live")));
});

test("reopens a Pi tab after its process exits", async (t) => {
  const windows = [{ label: `pi:${ID}`, window_id: "window:old", layers: [{ blocks: [{ creator_name: "com.superlogical.terminal", block_id: "block:old" }] }] }];
  const f = fixture({ windows, lastExit: { code: 0 } }); t.after(f.cleanup);
  await f.plugin.onload();
  const result = await f.helpers.openInRex(f.plugin.settings, "/session.jsonl", ID, f.home);
  assert.equal(result, "Opened the Pi session in Rex.");
  assert.ok(f.calls.some(({ args }) => args.includes("--session") && args.includes("/session.jsonl")));
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

test("renders the compact card with the title, start time, message count, ID, and button only", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact" } }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  assert.equal(el.children[0].cls, "pi-session-card pi-session-compact");
  const start = new Date("2026-01-01T00:00:00Z").toLocaleString();
  assert.deepEqual(texts(el), ["fix the test", `${start}  ·  2 messages`, ID, "Open in Rex"]);
});

test("refreshes cards from the command and reads the session file again", async (t) => {
  const f = fixture({ settings: { cardLayout: "compact" } }); t.after(f.cleanup);
  writeSession(f.home);
  await f.plugin.onload();
  const el = fakeEl();
  f.plugin.processor(ID, el);
  const file = path.join(f.home, ".pi", "agent", "sessions", "--home--", `test_${ID}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: "session_info", name: "renamed" }) + "\n");
  f.plugin.commands["refresh-pi-session-cards"].callback();
  assert.equal(texts(el)[0], "renamed");
  assert.ok(f.notices.includes("Refreshed 1 Pi session card."));
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
