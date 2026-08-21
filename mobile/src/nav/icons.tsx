/*
 * Every mark the navigation draws, as geometry the app carries itself.
 *
 * They used to be single characters — ◎ for Now, ⑂ for pull requests, ⚙ for
 * settings — and on the phone several of them came out as empty boxes, because
 * Android's system font carries no glyph for them and the fallback chain runs
 * out. That is not a styling complaint: it is a bar where several destinations
 * have no mark at all until you read the label under them.
 *
 * They are drawn in the desk rail's coordinate system — a 24-unit box, see
 * web/src/components/workspace/icons.tsx — and most of them are that rail's own
 * shapes, unaltered. A pull request should not be one thing on the computer and
 * a different one in your hand. Of the eight below, six are the rail's
 * (Home/DashIcon, Chats, Terminal, Prs, Repos/FilesIcon, Tasks/IssuesIcon) and
 * two are the phone's own, each for a reason written over it.
 *
 * They live here rather than in the tab layout because the bar stopped being
 * the only thing that draws them: Home's band wears the Now ring, Home's header
 * wears the faders, and Review's segmented control wears the pull request and
 * the checklist. Six of these eight are now used somewhere that is not a tab.
 */
// Expo Go carries react-native-svg, which is the only reason it may be
// imported at the top of a file the router reaches. See
// test/native-imports.test.ts: a module that is NOT in the build throws on
// import here and takes the whole route tree down with it, which is how this
// app shipped a blank screen twice.
import Svg, { Circle, Path } from "react-native-svg";
import type { ColorValue } from "react-native";

/** What every icon shares.
 *
 *  20px inside the slot the bar hands out, so nothing clips and the label keeps
 *  its line. The box is 24 units rather than 20 so a shape can be lifted from
 *  the desk's rail unchanged; 2.1 units of stroke in a 24-unit box drawn at 20px
 *  is 1.75px of ink on the glass. */
const line = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.1,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

/** The bar resolves this from its own active/inactive colours and renders each
 *  icon twice to cross-fade between the two. Taking the colour it offers rather
 *  than reading the palette again is what keeps the fade from jumping.
 *
 *  `size` exists for the star, which is drawn at 26 in a 52-point circle. The
 *  stroke is in the viewBox's units, so it scales with the glyph and the star's
 *  ink comes out at 2.3px rather than 1.75 — heavier, which is what a mark
 *  sitting on a filled colour needs. */
export type IconProps = { color: ColorValue; size?: number };

const box = (size: number): { width: number; height: number } => ({ width: size, height: size });

/**
 * A ring with its centre marked.
 *
 * Not a bell. The screen it opens argues at some length that it is a queue you
 * can empty rather than a notifications inbox, and a bell would promise exactly
 * the thing the list refuses to be. A ring also carries the badge better than
 * any other shape here: the count sits in empty space.
 */
export function NowIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Circle cx="12" cy="12" r="8.4" />
      <Circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** The rail's own: a prompt, and the line you type on. */
export function TerminalIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Path d="M6 8l3.5 4L6 16" />
      <Path d="M12.5 16.5H18" />
    </Svg>
  );
}

/** The rail's own, at Octicons' proportions: one line carries on, the other
 *  asks to come in, and the arrow is the ask. The circles are r=3, which at
 *  20px leaves a 3.2px hole — the desk draws the same shape at 15px, where the
 *  hole is 2.5px, so this is the size it has already survived. */
export function PrsIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Circle cx="6" cy="6" r="3" />
      <Path d="M6 9v12" />
      <Circle cx="18" cy="18" r="3" />
      <Path d="M18 15V8a2 2 0 0 0-2-2h-4.5" />
      <Path d="M13.5 3.5 11 6l2.5 2.5" />
    </Svg>
  );
}

/**
 * An open tray, for the screen that gathers what is waiting on you.
 *
 * Drawn for the Review destination, which held pull requests and cards behind
 * one control; it now marks the Inbox, which is the same claim made about one
 * more source. What it has to say is what all three share: something arrived
 * from outside and is waiting on a decision. A tray says that, and no single
 * source's own mark can without making the other two invisible.
 *
 * Open at the top, with the notch, and that is the whole of the drawing
 * decision. A closed box with a line across it — which is what every stock
 * "inbox" is — is a folder at 20px, and there is a folder two slots away in
 * Settings. This has no top edge at all: its silhouette is a U with a bite out
 * of the shoulders, which nothing else in the bar shares.
 */
export function InboxIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Path d="M3 13.4h5.2l1.7 2.8h4.2l1.7-2.8H21" />
      <Path d="M3 13.4v3.7a2.6 2.6 0 0 0 2.6 2.6h12.8a2.6 2.6 0 0 0 2.6-2.6v-3.7L18.3 5.6a2.6 2.6 0 0 0-2.4-1.6H8.1a2.6 2.6 0 0 0-2.4 1.6z" />
    </Svg>
  );
}

/**
 * A folder, which is the rail's mark for a checkout you browse.
 *
 * The screen is really about what has changed in one, so the desk's diff page
 * — with its + and − — was the other candidate. It loses here for a reason
 * that only applies to a tab bar: two page-shaped icons a thumb apart are one
 * icon. A folder shares its silhouette with nothing else in the bar.
 */
export function ReposIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Path d="M3 6.6a2 2 0 0 1 2-2h3.5l2 2.6H19a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <Path d="M3 9.7h18" />
    </Svg>
  );
}

/**
 * GitHub's own issue mark: a ring with a solid centre.
 *
 * It shares its outline with NowIcon, and the fill is what separates them —
 * deliberately, because they are never in the bar together. Now is off the bar
 * and wears the ring in Settings; this one is a destination and wears the dot.
 * A stroked inner circle at 20px is a 3.2px hole and a filled one is a 5.2px
 * blob, which is the difference a thumb can see at arm's length.
 *
 * Not a bug, an exclamation mark or a speech bubble: an issue is not
 * necessarily any of those, and this is the shape the site it comes from uses.
 */
export function IssuesIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Circle cx="12" cy="12" r="8.4" />
      <Circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** The rail's own checklist: the one shape that reads as "things to do" rather
 *  than "things that happened". */
export function TasksIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Path d="M3.5 6.5l2 2 3.5-3.5" />
      <Path d="M12 7h9" />
      <Path d="M3.5 15.5l2 2 3.5-3.5" />
      <Path d="M12 16h9" />
    </Svg>
  );
}

/**
 * Three faders, because the cog does not survive this weight.
 *
 * A cog's teeth cannot be drawn wider than the stroke, and eight of them on a
 * ring of radius 7.6 units come out as 1.75px of tooth in a 5px pitch at 20px:
 * a circle with eight spokes, which is a sun. The rail has no cog to borrow
 * either. Faders are vertical where the checklist is horizontal, and the
 * crossbars sit at three different heights so no two ever line up.
 */
export function SettingsIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Path d="M6 4v16M12 4v16M18 4v16" />
      <Path d="M4 8.5h4" />
      <Path d="M10 14.5h4" />
      <Path d="M16 7h4" />
    </Svg>
  );
}

/** The way back out of a screen the bar cannot return you to — Now and
 *  Settings, which are tabs with no tab. A chevron rather than "‹", which is
 *  the character problem this whole file exists to avoid. */
export function BackIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

/** The affordance on a row that opens something else. */
export function ChevronIcon({ color, size = 20 }: IconProps): React.ReactNode {
  return (
    <Svg {...line} {...box(size)} color={color}>
      <Path d="M9 5l7 7-7 7" />
    </Svg>
  );
}
