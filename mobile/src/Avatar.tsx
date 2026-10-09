/*
 * Somebody's face: one component for every person the phone draws.
 *
 * It was a ClickUp-only `Face` on a card's comments. A pull request has people
 * too, and a second component for them is how a card's author and a pull
 * request's author end up different sizes and different greys. So this takes
 * whichever the caller has: a ready address (ClickUp's own, fetched as
 * written), a GitHub login (fetched through the computer's proxy, see
 * model/avatar.ts), or neither.
 *
 * The initials are always underneath. They are what shows while a picture is
 * on its way and what stays when it fails, in the colour ClickUp gave the
 * person or a tint of the name's own hue, rather than a broken box or a hole
 * that jumps when the picture lands. Automation gets a robot, not a picture:
 * its address would be some other person's.
 */
import { useMemo, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { AVATAR, githubFace, hueOf, isBotLogin, isDead, markDead } from "./model/avatar.ts";
import { initialsOf } from "./model/initials.ts";
import { Glyph } from "./nav/glyphs.tsx";
import { useAgentglass } from "./state/host-context.tsx";
import { C, ink } from "./theme.ts";

export { AVATAR };

export function Avatar({ name, login, avatar, bot, initials, color, size = AVATAR.field }: {
  name: string;
  /** A GitHub login: the picture comes through the computer. */
  login?: string;
  /** A ready address (ClickUp's), used as written. */
  avatar?: string;
  /** Automation. Defaults to what the login's `[bot]` suffix says. */
  bot?: boolean;
  initials?: string;
  /** The colour the workspace gave the person. */
  color?: string;
  size?: number;
}): React.ReactNode {
  const { host } = useAgentglass();
  const [, repaint] = useState(0);
  const isBot = bot ?? (login ? isBotLogin(login) : false);
  // A new {uri, headers} each render would hand <Image> a new source each time.
  const origin = host?.origin, token = host?.token;
  const github = useMemo(
    () => (isBot || origin === undefined || token === undefined ? null : githubFace({ origin, token }, login)),
    [isBot, origin, token, login],
  );
  const source = github ?? (avatar && !isBot ? { uri: avatar } : null);
  const show = source && !isDead(source.uri);

  const hue = hueOf(name || login || "?");
  const ground = color || (isBot ? C.bg3 : `hsla(${hue}, 55%, 55%, 0.28)`);
  const face = color ? ink(color) : C.text;
  return (
    <View
      accessibilityLabel={name}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: ground, alignItems: "center", justifyContent: "center", overflow: "hidden" }}
    >
      {isBot ? (
        <Glyph name="bot" color={C.text2} size={Math.round(size * 0.6)} weight={1.9} />
      ) : (
        <Text style={{ color: face, fontSize: size * 0.4, fontWeight: "700" }}>
          {(initials || initialsOf(name || login || "")).slice(0, 2)}
        </Text>
      )}
      {show ? (
        <Image
          source={source}
          onError={() => { markDead(source.uri); repaint((n) => n + 1); }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

/** Faces tucked under one another, for a list row or a field: who is on it. */
export function AvatarStack({ people, ground = C.bg2, size = AVATAR.stack }: {
  people: readonly { id?: string | number; name: string; avatar?: string; initials?: string; color?: string }[];
  /** The colour of what it sits on, so the ring that separates two faces matches it. */
  ground?: string;
  size?: number;
}): React.ReactNode {
  const overlap = Math.round(size / 3);
  return (
    <View style={{ flexDirection: "row", paddingLeft: overlap }}>
      {people.map((p, i) => (
        <View key={p.id ?? `${p.name}${i}`} style={{ marginLeft: -overlap, borderRadius: size, borderWidth: 2, borderColor: ground }}>
          <Avatar name={p.name} avatar={p.avatar} initials={p.initials} color={p.color} size={size} />
        </View>
      ))}
    </View>
  );
}
