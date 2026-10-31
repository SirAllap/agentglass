// One line per show of the Browser view, for the day it comes up blank.
//
// The view is hidden with `visibility`, and a <webview> shown again can stay
// unpainted on a real compositor while painting fine in an isolated run on a
// workspace nobody looks at. Nothing on screen says which of "no webview",
// "tab asleep" or "guest never painted" it was, so each show writes what was
// true at that moment. Its own file so a test can require() it without main.js.
//
// Ceiling, named: the log is rewritten whole to stay at MAX_LINES, which is
// fine at one line per view switch and wrong for anything chattier.

const fs = require("fs");
const path = require("path");
const os = require("os");

const MAX_LINES = 200;

function logPath(env = process.env) {
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agentglass", "browser-show.log");
}

/** Append one line and keep only the newest `max`. Never throws: a log that
 *  cannot be written must not take the view with it. */
function appendCapped(file, line, max = MAX_LINES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines = [];
    try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { /* first line */ }
    lines.push(line);
    fs.writeFileSync(file, lines.slice(-max).join("\n") + "\n");
  } catch { /* see above */ }
}

/** `key=value` pairs, one line. Values are stripped of whitespace so a line
 *  stays one line whatever a tab id or state contains. */
function showLine(f) {
  return Object.entries(f).map(([k, v]) => `${k}=${String(v).replace(/\s+/g, "_")}`).join(" ");
}

module.exports = { MAX_LINES, logPath, appendCapped, showLine };
