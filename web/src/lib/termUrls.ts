// The URL the terminal links. The addon's own regex stops before most of the
// punctuation that ends a sentence, but it keeps a trailing `;` and cannot read
// a URL with a bracket pair in it (`/wiki/Orbit_(ship)`), so this one is passed
// in as `urlRegex`. A `(…)` group with no brackets inside is part of the URL;
// a lone `(` or `)` is not. Ceiling: a pair nested inside a pair is not read.
const GROUP = String.raw`\([^\s"'()<>` + "`" + String.raw`]*\)`;
const BODY = String.raw`(?:[^\s"'!*(){}|\\^<>` + "`" + String.raw`]|${GROUP})*`;
const LAST = String.raw`(?:[^\s"':,.;!?{}|\\^~\[\]()<>` + "`" + String.raw`]|${GROUP})`;

export const TERM_URL = new RegExp(String.raw`(https?|HTTPS?):[/]{2}${BODY}${LAST}`);
