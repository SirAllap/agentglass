/*
 * Where a snapshot's data comes from in the running window: the stores and the
 * pref modules, read when asked and never subscribed to. Kept apart from
 * uiSnapshots.ts so the providers stay pure and a test never has to load a store
 * (chatStore pulls in the API client and its persistence).
 */
import type { Sources, AppSlice } from "./uiSnapshots.ts";
import { listChats, getActiveChatId } from "./chatStore.ts";
import { benchState } from "./benchStore.ts";
import { listGates } from "./gateStore.ts";
import { diffSplit, diffWrap, diffNoWhitespace, diffThemePref } from "./diffPrefs.ts";
import {
  currentTermFont, currentTermSize, currentTermCursor, currentTermLineHeight, currentScrollback,
  currentWordSeparators, copyOnSelect, currentNoteEditor,
} from "./termPrefs.ts";
import { homePage, searchEngine, zoomLevel, importHistory, importBookmarks } from "./browserPrefs.ts";
import { getNotifyPrefs } from "./notifyPrefsStore.ts";
import {
  readPrefs, readRail, readKeys, readTasks, readAppearance, readUnderstudy, readHooks, readLantern, readBudgets, readRecipes,
  readReviewPrompts, readSavedReplies, readTmux, readPrivacy, readPlugins, readLog, readAbout,
} from "./paneState.ts";

export const liveSources = (app: () => AppSlice): Sources => ({
  app,
  chats: () => ({ list: listChats(), activeId: getActiveChatId() }),
  bench: benchState,
  gates: listGates,
  diff: () => ({ split: diffSplit(), wrap: diffWrap(), noWhitespace: diffNoWhitespace(), theme: diffThemePref() }),
  terminal: () => ({
    font: currentTermFont(), size: currentTermSize(), cursor: currentTermCursor(), lineHeight: currentTermLineHeight(),
    scrollback: currentScrollback(), wordSeparators: currentWordSeparators(), copyOnSelect: copyOnSelect(), noteEditor: currentNoteEditor(),
  }),
  browser: () => ({ home: homePage(), engine: searchEngine(), zoomLevel: zoomLevel(), importHistory: importHistory(), importBookmarks: importBookmarks() }),
  notify: getNotifyPrefs,
  prefs: readPrefs,
  rail: readRail,
  keys: readKeys,
  tasks: readTasks,
  appearance: readAppearance,
  understudy: readUnderstudy,
  later: {
    hooks: readHooks, lantern: readLantern, budgets: readBudgets, recipes: readRecipes, reviewPrompts: readReviewPrompts,
    savedReplies: readSavedReplies, tmux: readTmux, privacy: readPrivacy, plugins: readPlugins, log: readLog, about: readAbout,
  },
});
