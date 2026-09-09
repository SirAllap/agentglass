/*
 * Rendered markdown, in this app's own type and colour.
 *
 * The parser next door decides what a body IS; this decides what it looks
 * like, and every value it uses comes from `theme.ts` rather than from a
 * stylesheet of its own — a renderer with its own idea of a heading is how a
 * screen ends up looking like two apps.
 *
 * Three things here are not decoration:
 *
 *   A task list draws real boxes. Every pull request in this project opens
 *   with a checklist, and "is that one ticked" is the question it exists to
 *   answer.
 *
 *   A table scrolls inside its own box. Nothing else on a 393-point screen may
 *   scroll sideways, and a table that forces the page to is worse than a table
 *   that is cut off.
 *
 *   An image goes through the server. GitHub's attachment host answers 404
 *   without the token the sidecar attaches, so a body's screenshot loaded
 *   directly is a broken box on every phone — see `prAsset` in server/src/prs.ts.
 */
import { memo, useState } from "react";
import { Image, Linking, ScrollView, Text, View } from "react-native";
import type { Host } from "../lib/host.ts";
import { C, MONO, RADIUS, SPACE, T } from "../theme.ts";
import { inlineText, parseMarkdown, type Block, type Inline, type ListItem } from "./parse.ts";

/** GitHub's own attachment addresses, which need the sidecar's token. Anything
 *  else — a badge, a raw file, somebody's blog — is fetched as written. */
const NEEDS_TOKEN = /^https:\/\/(?:github\.com\/user-attachments|private-user-images\.githubusercontent\.com|user-images\.githubusercontent\.com)\//;

const HEADING_SIZE: Record<number, number> = { 1: T.head, 2: T.title, 3: T.body + 1, 4: T.body, 5: T.body, 6: T.body };

/** Inline spans, as one Text so the line wraps as a line rather than as a row
 *  of boxes that break wherever a span ends. */
function Spans({ kids, size, color }: { kids: Inline[]; size: number; color: string }): React.ReactNode {
  return (
    <>
      {kids.map((k, i) => {
        if (k.t === "text") return <Text key={i} style={{ color, fontSize: size }}>{k.text}</Text>;
        if (k.t === "code") {
          return (
            <Text key={i} style={{
              color: C.text, fontFamily: MONO, fontSize: size - 1.5,
              backgroundColor: C.bg3,
            }}> {k.text} </Text>
          );
        }
        if (k.t === "strong") {
          return <Text key={i} style={{ fontWeight: "700", color: C.text, fontSize: size }}><Spans kids={k.kids} size={size} color={C.text} /></Text>;
        }
        if (k.t === "em") {
          return <Text key={i} style={{ fontStyle: "italic", color, fontSize: size }}><Spans kids={k.kids} size={size} color={color} /></Text>;
        }
        return (
          <Text
            key={i}
            accessibilityRole="link"
            onPress={() => { void Linking.openURL(k.href).catch(() => { /* no app for it */ }); }}
            style={{ color: C.primary, fontSize: size }}
          >
            <Spans kids={k.kids} size={size} color={C.primary} />
          </Text>
        );
      })}
    </>
  );
}

/** A body's image. It is given a height once it has one, because a phone
 *  showing a full-width box of nothing while a screenshot loads is a layout
 *  that jumps under the reader's thumb. */
function BodyImage({ src, alt, host }: { src: string; alt: string; host: Host | null }): React.ReactNode {
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const through = host && NEEDS_TOKEN.test(src)
    ? { uri: `${host.origin}/prs/asset?url=${encodeURIComponent(src)}`, headers: { authorization: `Bearer ${host.token}` } }
    : { uri: src };

  if (failed) {
    return (
      <Text style={{ color: C.text3, fontSize: T.small, fontStyle: "italic" }}>
        {alt ? `${alt} — image did not load` : "an image did not load"}
      </Text>
    );
  }
  return (
    <Image
      accessibilityLabel={alt || "image"}
      source={through}
      onError={() => setFailed(true)}
      onLoad={(e) => {
        const { width, height } = e.nativeEvent.source;
        if (width > 0 && height > 0) setRatio(width / height);
      }}
      resizeMode="contain"
      style={{ width: "100%", aspectRatio: ratio ?? 16 / 9, borderRadius: RADIUS.sm, backgroundColor: C.bg2 }}
    />
  );
}

function Items({ list, host }: { list: Extract<Block, { t: "list" }>; host: Host | null }): React.ReactNode {
  return (
    <View style={{ gap: SPACE.sm }}>
      {list.items.map((item: ListItem, i) => (
        <View key={i} style={{ gap: SPACE.sm }}>
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            {item.checked === null ? (
              <Text style={{ color: C.text3, fontSize: T.body, lineHeight: 21, width: list.ordered ? undefined : 14 }}>
                {list.ordered ? `${list.start + i}.` : "•"}
              </Text>
            ) : (
              <View style={{
                width: 16, height: 16, marginTop: 3, borderRadius: RADIUS.sm,
                alignItems: "center", justifyContent: "center",
                backgroundColor: item.checked ? C.primary : "transparent",
                borderWidth: item.checked ? 0 : 1.5,
                borderColor: C.border2,
              }}>
                {item.checked ? <Text style={{ color: C.bg, fontSize: 11, fontWeight: "900", lineHeight: 13 }}>✓</Text> : null}
              </View>
            )}
            <Text style={{ flex: 1, color: C.text2, fontSize: T.body, lineHeight: 21 }}>
              <Spans kids={item.kids} size={T.body} color={C.text2} />
            </Text>
          </View>
          {item.children.length ? (
            <View style={{ paddingLeft: SPACE.lg, gap: SPACE.sm }}>
              <Blocks blocks={item.children} host={host} />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Blocks({ blocks, host }: { blocks: Block[]; host: Host | null }): React.ReactNode {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h":
            return (
              <Text key={i} style={{
                color: C.text, fontSize: HEADING_SIZE[b.level] ?? T.body, fontWeight: "700",
                lineHeight: (HEADING_SIZE[b.level] ?? T.body) + 6, marginTop: i === 0 ? 0 : SPACE.xs,
              }}>
                <Spans kids={b.kids} size={HEADING_SIZE[b.level] ?? T.body} color={C.text} />
              </Text>
            );
          case "p":
            return (
              <Text key={i} style={{ color: C.text2, fontSize: T.body, lineHeight: 21 }}>
                <Spans kids={b.kids} size={T.body} color={C.text2} />
              </Text>
            );
          case "code":
            return (
              /* Scrolled rather than wrapped, and this is the one place that
                 differs from the diff: a diff line is short enough to wrap
                 with a hanging indent, but a pasted block is often a table or
                 a stack trace where a broken line is a wrong line. React
                 Native has no text-indent to hang it with either. */
              <ScrollView key={i} horizontal showsHorizontalScrollIndicator={false} style={{
                backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.sm,
              }}>
                <Text style={{ color: C.text2, fontFamily: MONO, fontSize: T.small, lineHeight: 18, padding: SPACE.md }}>
                  {b.text}
                </Text>
              </ScrollView>
            );
          case "quote":
            return (
              <View key={i} style={{
                borderLeftWidth: 3, borderLeftColor: C.border2,
                paddingLeft: SPACE.md, gap: SPACE.sm,
              }}>
                <Blocks blocks={b.blocks} host={host} />
              </View>
            );
          case "list":
            return <Items key={i} list={b} host={host} />;
          case "hr":
            return <View key={i} style={{ height: 1, backgroundColor: C.border }} />;
          case "image":
            return <BodyImage key={i} src={b.src} alt={b.alt} host={host} />;
          case "table":
            return (
              <ScrollView key={i} horizontal showsHorizontalScrollIndicator={false}
                style={{ borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.sm, backgroundColor: C.bg2 }}
              >
                <View>
                  <View style={{ flexDirection: "row", backgroundColor: C.bg3 }}>
                    {b.head.map((cell, c) => (
                      <Text key={c} style={{
                        minWidth: 96, maxWidth: 220, padding: SPACE.sm,
                        color: C.text, fontSize: T.small, fontWeight: "700",
                      }}>
                        <Spans kids={cell} size={T.small} color={C.text} />
                      </Text>
                    ))}
                  </View>
                  {b.rows.map((row, r) => (
                    <View key={r} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: C.border }}>
                      {row.map((cell, c) => (
                        <Text key={c} style={{
                          minWidth: 96, maxWidth: 220, padding: SPACE.sm,
                          color: C.text2, fontSize: T.small,
                        }}>
                          <Spans kids={cell} size={T.small} color={C.text2} />
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
        }
      })}
    </>
  );
}

/**
 * A body, rendered.
 *
 * `limit` caps how many blocks are drawn — a coverage table pasted into a
 * comment is 46,551 characters at the desk, and text layout is what React
 * Native spends its time on. The caller decides what "the rest" looks like,
 * because only the caller knows whether there is room for an expander.
 */
export const Md = memo(function Md({ text, host, limit }: {
  text: string;
  host: Host | null;
  limit?: number;
}): React.ReactNode {
  const blocks = parseMarkdown(text);
  const shown = limit && blocks.length > limit ? blocks.slice(0, limit) : blocks;
  if (!shown.length) return null;
  return (
    <View style={{ gap: SPACE.md }}>
      <Blocks blocks={shown} host={host} />
    </View>
  );
});

/**
 * What is behind the fold, so a caller can name it.
 *
 * A collapsed section has to give the reader enough to decide whether to open
 * it; "Show more" under a hard cut does not. The next heading is the best
 * single word for that, and the count covers a body with no headings at all.
 */
export function outline(text: string, limit: number): { hidden: number; nextHeading: string | null } {
  const blocks = parseMarkdown(text);
  const rest = blocks.slice(limit);
  const heading = rest.find((b) => b.t === "h");
  return {
    hidden: rest.length,
    nextHeading: heading && heading.t === "h" ? inlineText(heading.kids) : null,
  };
}
