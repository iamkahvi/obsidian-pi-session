const { Plugin } = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const MAX_CHARS = 300;

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

module.exports = class PiSessionPlugin extends Plugin {
  onload() {
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
      card.createDiv({ cls: "pi-session-id", text: id });
    });
  }
};
