import { describe, expect, it } from "bun:test";
import { parseBlocks, noteFrom, urlIn } from "../src/notifications.ts";

/**
 * These fixtures are verbatim dbus-monitor output, captured from a real GNOME
 * session rather than written by hand. That matters: the format has three
 * traps you would not invent — unescaped embedded quotes, strings that keep
 * their raw newlines, and every notification crossing the bus twice.
 */

const SIMPLE = `signal time=1784625329.084378 sender=org.freedesktop.DBus -> destination=:1.3511 serial=2 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired
   string ":1.3511"
method call time=1784625335.884506 sender=:1.3514 -> destination=:1.42 serial=9 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Slack"
   uint32 0
   string ""
   string "Alex Rivera"
   string "can you take the sync card?"
   array [
   ]
   array [
      dict entry(
         string "urgency"
         variant             byte 1
      )
      dict entry(
         string "sender-pid"
         variant             int64 1754978
      )
   ]
   int32 -1
method call time=1784625335.886139 sender=:1.42 -> destination=:1.31 serial=684 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Slack"
   uint32 0
   string ""
   string "Alex Rivera"
   string "can you take the sync card?"
   array [
   ]
   array [
      dict entry(
         string "urgency"
         variant             byte 1
      )
      dict entry(
         string "x-shell-sender-pid"
         variant             uint32 1754978
      )
      dict entry(
         string "x-shell-sender"
         variant             string ":1.3514"
      )
   ]
   int32 -1
`;

const AWKWARD = `method call time=1784625444.319273 sender=:1.3538 -> destination=:1.42 serial=9 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Slack"
   uint32 0
   string ""
   string "He said "hi""
   string "line one
line two — em dash, <b>markup</b>, emoji 🎉 and a tail"
   array [
   ]
   array [
      dict entry(
         string "urgency"
         variant             byte 2
      )
   ]
   int32 -1
`;

describe("dbus-monitor parsing", () => {
  it("reads app, summary, body and urgency off a Notify call", () => {
    const notes = parseBlocks(SIMPLE).map(noteFrom).filter(Boolean);
    expect(notes.length).toBe(1); // the daemon's forwarded copy is dropped
    expect(notes[0]).toEqual({
      app: "Slack",
      summary: "Alex Rivera",
      body: "can you take the sync card?",
      urgency: 1,
    });
  });

  it("drops the daemon's re-dispatch, which is what x-shell-sender marks", () => {
    const blocks = parseBlocks(SIMPLE).filter((b) => b.member === "Notify");
    expect(blocks.length).toBe(2); // both really are on the bus
    expect(blocks.filter((b) => noteFrom(b) !== null).length).toBe(1);
  });

  it("survives unescaped quotes and multi-line bodies", () => {
    const [note] = parseBlocks(AWKWARD).map(noteFrom).filter(Boolean);
    expect(note!.summary).toBe(`He said "hi"`);
    expect(note!.body).toBe("line one\nline two — em dash, <b>markup</b>, emoji 🎉 and a tail");
    expect(note!.urgency).toBe(2);
  });

  it("finds the link a notification carries, and nothing else", () => {
    // The real shape: a chat app quoting a message that contains a task link.
    expect(urlIn("have a look at https://tasks.example.com/t/86c4abc12 when you can"))
      .toBe("https://tasks.example.com/t/86c4abc12");
    // Sentence punctuation is not part of the address.
    expect(urlIn("see https://example.com/x.")).toBe("https://example.com/x");
    // Nothing to open is the common case and must stay undefined, so the UI
    // shows no button rather than one that goes nowhere.
    expect(urlIn("Alex unassigned this task from: Nightly report")).toBeUndefined();
    // Only the web. A notification is not allowed to name a local file.
    expect(urlIn("file:///etc/passwd")).toBeUndefined();
    expect(urlIn("javascript:alert(1)")).toBeUndefined();
  });

  it("ignores traffic that is not a notification", () => {
    const signalOnly = SIMPLE.split("method call")[0]!;
    expect(parseBlocks(signalOnly).map(noteFrom).filter(Boolean)).toEqual([]);
  });

  it("reads GTK's AddNotification, whose text lives in a dict", () => {
    const gtk = `method call time=1.0 sender=:1.9 -> destination=:1.42 serial=3 path=/org/gtk/Notifications; interface=org.gtk.Notifications; member=AddNotification
   string "org.gnome.Calendar"
   string "event-1"
   array [
      dict entry(
         string "title"
         variant             string "Team standup"
      )
      dict entry(
         string "body"
         variant             string "starts in 5 minutes"
      )
   ]
`;
    const [note] = parseBlocks(gtk).map(noteFrom).filter(Boolean);
    expect(note).toEqual({
      app: "org.gnome.Calendar",
      summary: "Team standup",
      body: "starts in 5 minutes",
      urgency: 1,
    });
  });
});
