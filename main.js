const { Plugin } = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

function findSessionFile(id) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    const full = path.join(SESSIONS_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const hit = fs.readdirSync(full).find((file) => file.endsWith(`_${id}.jsonl`));
    if (hit) return path.join(full, hit);
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parseSession(file) {
  const info = { name: null, firstUser: "" };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === "session_info" && entry.name) info.name = entry.name;
    if (entry.type === "message" && entry.message?.role === "user" && !info.firstUser) {
      info.firstUser = textOf(entry.message.content);
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

      const session = parseSession(file);
      card.createDiv({ cls: "pi-session-title", text: session.name || "(no name)" });

      const prompt = card.createDiv({ cls: "pi-session-row" });
      prompt.createDiv({ cls: "pi-session-label", text: "First prompt" });
      prompt.createDiv({ cls: "pi-session-text", text: session.firstUser || "(none)" });
    });
  }
};
