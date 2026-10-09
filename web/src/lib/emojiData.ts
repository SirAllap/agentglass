/*
 * The emoji the card composer's picker offers, and the small decisions around
 * them (search, arrow keys in the grid, the "frequently used" row, where the
 * popover goes) kept out of the component so they can be tested as plain code.
 *
 * A curated list rather than the whole Unicode set or a package: about three
 * hundred is what a comment on a card actually reaches for, and one more
 * dependency for a picker is the wrong trade. Its ceiling is honest — no skin
 * tones, no rare flags, no emoji newer than what the system font draws — and
 * a missing one is a line in the table below, not a migration. Linux's
 * platform panel is not an option: Electron's showEmojiPanel does nothing there.
 *
 * Each line is `glyph keyword keyword…`; the first word is the name shown as a
 * tooltip. Keywords are what search matches, so "fire" finds the flame and the
 * fire engine and the cracker.
 */

export type EmojiCategory = "people" | "nature" | "food" | "activity" | "travel" | "objects" | "symbols" | "flags";

export interface Emoji {
  char: string;
  cat: EmojiCategory;
  /** The first is the name. */
  words: string[];
}

export const CATEGORIES: { id: EmojiCategory; label: string; icon: string }[] = [
  { id: "people", label: "Smileys & People", icon: "😀" },
  { id: "nature", label: "Animals & Nature", icon: "🐻" },
  { id: "food", label: "Food & Drink", icon: "🍔" },
  { id: "activity", label: "Activities", icon: "⚽" },
  { id: "travel", label: "Travel & Places", icon: "🚗" },
  { id: "objects", label: "Objects", icon: "💡" },
  { id: "symbols", label: "Symbols", icon: "❤️" },
  { id: "flags", label: "Flags", icon: "🏁" },
];

const TABLE: Record<EmojiCategory, string[]> = {
  people: [
    "😀 grinning happy smile", "😄 smile happy joy",
    "😅 sweat_smile nervous relief phew", "😂 joy tears laugh", "🙂 slight_smile", "🙃 upside_down",
    "😊 blush smile", "😇 innocent angel halo", "🥰 love hearts adore", "😍 heart_eyes love",
    "🤩 star_struck wow", "😘 kiss", "😜 wink_tongue silly",
    "🤗 hug hugging", "🤫 shush quiet secret", "🤔 thinking hmm",
    "🤨 raised_eyebrow skeptical", "😐 neutral",
    "🙄 eye_roll", "😏 smirk", "😬 grimace awkward",
    "😌 relieved calm", "😷 mask sick",
    "🤕 hurt bandage", "🤮 vomit",
    "🤯 mind_blown exploding",
    "🥳 party celebrate", "😎 cool sunglasses", "🤓 nerd", "😕 confused",
    "😮 open_mouth surprised", "😳 flushed embarrassed",
    "🥺 pleading puppy", "😰 anxious sweat",
    "😢 cry tear", "😭 sob crying", "😱 scream fear",
    "😡 angry rage", "😠 mad angry",
    "💀 skull dead", "💩 poop", "👻 ghost",
    "🤖 robot bot", "🙈 see_no_evil monkey", "🙊 speak_no_evil",
    "👋 wave hello bye", "✋ raised_hand stop high_five", "✌️ victory peace", "👌 ok perfect",
    "🤞 crossed_fingers luck",
    "👍 thumbsup +1 yes approve like", "👎 thumbsdown -1 no dislike", "👏 clap applause",
    "🙌 raised_hands hooray", "🤝 handshake deal", "🙏 pray thanks please folded_hands", "💪 muscle strong flex",
    "👀 eyes look watching", "🧠 brain",
    "🤦 facepalm", "🤷 shrug", "🙇 bow sorry",
    "🧑‍💻 technologist developer coder",
  ],
  nature: [
    "🐶 dog", "🐱 cat", "🐰 rabbit bunny",
    "🦊 fox", "🐻 bear", "🐼 panda",
    "🐸 frog",
    "🐧 penguin", "🐦 bird",
    "🦄 unicorn",
    "🦋 butterfly", "🐝 bee honeybee", "🐛 bug caterpillar", "🐌 snail slow", "🐞 ladybug beetle bug",
    "🐢 turtle slow", "🐍 snake python",
    "🐙 octopus",
    "🐳 whale",
    "🐾 paw_prints",
    "🌳 tree",
    "🌱 seedling sprout grow", "🌿 herb leaf", "🍀 four_leaf_clover luck", "🍁 maple_leaf autumn",
    "🌹 rose", "🌻 sunflower", "🌸 cherry_blossom",
    "🌙 crescent_moon night", "⭐ star", "🌟 glowing_star", "✨ sparkles shine new", "⚡ zap lightning bolt fast",
    "🔥 fire flame hot lit", "🌈 rainbow", "☀️ sun sunny", "☁️ cloud",
    "❄️ snowflake cold", "💧 droplet water",
    "🌊 wave ocean sea", "🌍 earth globe world",
  ],
  food: [
    "🍎 apple red", "🍋 lemon",
    "🍌 banana", "🍉 watermelon", "🍓 strawberry",
    "🍍 pineapple",
    "🍅 tomato", "🥑 avocado",
    "🌶️ hot_pepper spicy chili", "🍞 bread",
    "🧀 cheese", "🍳 cooking fried_egg",
    "🍖 meat",
    "🍔 hamburger burger", "🍟 fries", "🍕 pizza", "🌮 taco",
    "🍝 spaghetti pasta", "🍜 ramen noodles",
    "🍣 sushi",
    "🍦 ice_cream", "🍩 doughnut donut", "🍪 cookie", "🎂 birthday cake", "🍰 shortcake cake",
    "🍫 chocolate", "🍬 candy", "🍿 popcorn",
    "☕ coffee hot_drink", "🍺 beer", "🍻 cheers beers",
    "🥂 clinking_glasses toast champagne", "🍾 champagne bottle celebrate",
    "🧊 ice cube", "🍴 fork_knife cutlery",
  ],
  activity: [
    "⚽ soccer football", "🏀 basketball", "🏈 american_football", "⚾ baseball", "🎾 tennis",
    "🏐 volleyball",
    "⛳ golf flag",
    "🏆 trophy win winner", "🥇 gold_medal first",
    "🏅 medal", "🎯 dart bullseye target goal",
    "🎮 video_game controller play", "🎲 dice game", "🧩 puzzle piece",
    "🎨 art palette design", "🎬 clapper movie", "🎤 microphone sing",
    "🎧 headphones music",
    "🎸 guitar", "🎉 tada party popper celebrate congrats",
    "🎈 balloon", "🎁 gift present", "🎃 jack_o_lantern halloween",
  ],
  travel: [
    "🚗 car", "🚕 taxi", "🏎️ racing_car fast",
    "🚒 fire_engine truck",
    "🚲 bicycle bike",
    "🚄 bullet_train fast", "✈️ airplane plane flight",
    "🚀 rocket launch ship",
    "⚓ anchor", "🚧 construction wip", "🚦 traffic_light", "🚨 rotating_light siren alert",
    "🗺️ map world", "🏔️ mountain snow",
    "🏖️ beach", "🏝️ island", "🏠 house home",
    "🏢 office building",
    "🏰 castle",
    "🌇 sunset",
    "⌛ hourglass wait", "⏰ alarm_clock", "🌅 sunrise",
  ],
  objects: [
    "⌚ watch", "📱 phone mobile", "💻 laptop computer", "⌨️ keyboard", "🖥️ desktop monitor",
    "💾 floppy save disk",
    "📷 camera photo", "🎥 movie_camera", "📺 tv television",
    "🔌 plug electric", "💡 bulb idea light",
    "💰 money_bag", "💳 credit_card payment", "💎 gem diamond",
    "🔧 wrench fix tool", "🔨 hammer build", "🛠️ tools hammer_wrench", "⚙️ gear settings cog",
    "🔗 link chain url",
    "🔒 lock locked secure", "🔓 unlock open", "🔑 key",
    "🛡️ shield security", "🔍 mag search magnifier",
    "💊 pill medicine", "🧪 test_tube experiment",
    "📝 memo note write", "📄 page document",
    "📊 bar_chart stats", "📈 chart_up increase", "📉 chart_down decrease", "📌 pushpin pin",
    "📍 round_pushpin location", "📎 paperclip attach", "✂️ scissors cut", "🗑️ wastebasket trash delete",
    "📁 folder", "📂 open_folder", "📦 package box",
    "📧 email mail", "✉️ envelope letter",
    "📚 books", "📖 book open", "🏷️ label tag", "📢 loudspeaker announce",
    "📣 megaphone", "🔔 bell notification", "💬 speech_balloon comment chat", "💭 thought_balloon",
    "📅 calendar date", "⏱️ stopwatch timer", "⏳ hourglass_flowing wait",
    "🧾 receipt invoice", "✏️ pencil edit",
    "🧹 broom clean sweep",
  ],
  symbols: [
    "❤️ heart love red",
    "💔 broken_heart",
    "💯 hundred perfect 100",
    "💥 boom collision", "💨 dash wind fast",
    "✅ white_check_mark check done ok", "❌ x cross wrong no",
    "🚫 prohibited forbidden", "⚠️ warning caution", "❗ exclamation important", "❓ question",
    "⬆️ up_arrow", "⬇️ down_arrow", "⬅️ left_arrow", "➡️ right_arrow", "➕ plus add",
    "➖ minus remove", "♻️ recycle refactor", "🔁 repeat loop",
    "🔄 arrows_counterclockwise refresh sync",
    "▶️ play",
    "↩️ return_arrow undo",
    "↪️ redo_arrow", "🆕 new_button",
    "🔴 red_circle",
    "🟢 green_circle", "🔵 blue_circle",
    "#️⃣ hash number",
    "♾️ infinity",
  ],
  flags: [
    "🏁 checkered_flag finish race", "🚩 triangular_flag red_flag", "🏳️ white_flag surrender",
    "🏳️‍🌈 rainbow_flag pride", "🏴‍☠️ pirate_flag", "🇪🇺 european_union eu", "🇺🇸 united_states usa", "🇬🇧 united_kingdom uk britain",
    "🇪🇸 spain", "🇫🇷 france", "🇩🇪 germany", "🇮🇹 italy", "🇵🇹 portugal",
    "🇳🇱 netherlands",
    "🇨🇦 canada", "🇲🇽 mexico",
    "🇧🇷 brazil", "🇦🇷 argentina", "🇯🇵 japan",
    "🇰🇷 south_korea", "🇨🇳 china", "🇮🇳 india", "🇦🇺 australia",
  ],
};

export const EMOJI: Emoji[] = (Object.keys(TABLE) as EmojiCategory[]).flatMap((cat) =>
  TABLE[cat].map((line) => {
    const [char, ...words] = line.split(" ");
    return { char: char!, cat, words };
  }));

const BY_CHAR = new Map(EMOJI.map((e) => [e.char, e]));
export const emojiOf = (char: string): Emoji | undefined => BY_CHAR.get(char);

/** Every word of the query must start a keyword (or, from three letters on, sit
 *  inside one: "fire" finds `fire_engine`, "eng" finds it too). Keywords split
 *  on `_` as well, so "heart eyes" finds `heart_eyes`. Names that START with the
 *  query come first. */
export function searchEmoji(query: string, list: Emoji[] = EMOJI): Emoji[] {
  const q = query.trim().toLowerCase().split(/[\s_]+/).filter(Boolean);
  if (!q.length) return list;
  const scored: { e: Emoji; rank: number; i: number }[] = [];
  list.forEach((e, i) => {
    const parts = e.words.flatMap((w) => [w.toLowerCase(), ...w.toLowerCase().split("_")]);
    let rank = 0;
    for (const t of q) {
      if (parts.some((p) => p.startsWith(t))) { rank += e.words[0]!.toLowerCase().startsWith(t) ? 0 : 1; continue; }
      if (t.length >= 3 && parts.some((p) => p.includes(t))) { rank += 2; continue; }
      return;
    }
    scored.push({ e, rank, i });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((s) => s.e);
}

export const RECENT_KEY = "agx.emoji.recent";
export const RECENT_MAX = 10;
export const DEFAULT_RECENT = ["🙏", "❤️", "👍", "👀", "🔥", "✅", "😀", "🎉", "🤔", "😅"];

/** The row after `char` was used: it goes first, once, and the row stays short. */
export const pushRecent = (row: string[], char: string): string[] =>
  [char, ...row.filter((c) => c !== char)].slice(0, RECENT_MAX);

/** What is stored, or the default row. Anything that is not a list of known
 *  emoji (another version's format, hand-edited) is ignored rather than drawn. */
export function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "null");
    if (Array.isArray(v)) {
      const ok = v.filter((c): c is string => typeof c === "string" && BY_CHAR.has(c)).slice(0, RECENT_MAX);
      if (ok.length) return ok;
    }
  } catch { /* no storage, or not JSON: the default row */ }
  return DEFAULT_RECENT;
}
export function writeRecent(row: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(row)); } catch { /* private mode: not remembered */ }
}

/** Where the caret goes with an arrow key in a grid whose rows may be short
 *  (the last row of a section). Left/Right walk the flat order across rows;
 *  Up/Down keep the column, clamped to the row they land on. */
export function moveInGrid(rows: number[], at: { r: number; c: number }, key: string): { r: number; c: number } {
  if (!rows.length) return at;
  const last = rows.length - 1;
  if (key === "ArrowRight") return at.c < rows[at.r]! - 1 ? { r: at.r, c: at.c + 1 } : at.r < last ? { r: at.r + 1, c: 0 } : at;
  if (key === "ArrowLeft") return at.c > 0 ? { r: at.r, c: at.c - 1 } : at.r > 0 ? { r: at.r - 1, c: rows[at.r - 1]! - 1 } : at;
  if (key === "ArrowDown" && at.r < last) return { r: at.r + 1, c: Math.min(at.c, rows[at.r + 1]! - 1) };
  if (key === "ArrowUp" && at.r > 0) return { r: at.r - 1, c: Math.min(at.c, rows[at.r - 1]! - 1) };
  return at;
}

export interface Anchor { left: number; top: number; bottom: number; right: number }

/** Where the popover goes: above the button unless it does not fit and below
 *  has more room, and never off either side of the window. `height` is the
 *  most it wants; the result may be less, to fit the room there is. */
export function popoverPlace(a: Anchor, size: { width: number; height: number }, view: { width: number; height: number }, gap = 6, edge = 8):
  { left: number; top: number; height: number; up: boolean } {
  const above = a.top - gap - edge;
  const below = view.height - a.bottom - gap - edge;
  const up = above >= size.height || above >= below;
  const height = Math.max(160, Math.min(size.height, up ? above : below));
  const left = Math.max(edge, Math.min(a.left, view.width - size.width - edge));
  return { left, top: up ? a.top - gap - height : a.bottom + gap, height, up };
}
