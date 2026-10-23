import { useState } from "react";
import { avatarSrc } from "../../lib/avatarSrc.ts";
import { chipInk } from "../../lib/contrast.ts";

/** A person's face for a comment: their picture, or their initials where there is none or it did not load. */
export function Author({ who, initials, avatar, size = 18 }: { who: string; initials?: string; avatar?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size, borderRadius: 999 } as const;
  if (avatar && !broken) {
    return <img src={avatarSrc(avatar)} alt="" title={who} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)}
      className="shrink-0 object-cover" style={box} />;
  }
  return <span title={who} className="shrink-0 inline-flex items-center justify-center font-medium"
    style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.36)), background: "var(--bg4)", color: chipInk(null) }}>{initials || "?"}</span>;
}
