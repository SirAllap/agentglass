/**
 * A canned shell session, for the demo build only.
 *
 * The terminal is the panel this app is most often described by, and in the
 * demo it was a black rectangle with one line of grey text in the middle of it
 * — "the terminal is disabled in the demo". Someone who clicked through from
 * the landing page to see the shell found the one view that shows nothing.
 * `web/src/lib/demo.ts` already had to learn this lesson once, for the
 * pull-request panel, and the note there says it plainly: a dead panel is worse
 * than no panel.
 *
 * So the demo gets a real terminal with fabricated bytes rather than a fake
 * terminal. The renderer, the fonts, the theme, the colours, the reflow on
 * resize and the scrollback are the product's own — the only thing that is not
 * real is what a shell said, and there is no shell to say it. Nothing here
 * reaches the network: the demo build never opens the PTY socket.
 *
 * Written as ANSI rather than as styled markup for the same reason: `\x1b[32m`
 * is what a test runner actually emits, so the colours a visitor sees are the
 * ones the palette assigns to green, and a theme switch repaints them.
 *
 * The repositories, ports and branch names match the rest of the demo — the
 * ports panel lists vite on 5173 in `shop-web` and bun on 3000 in `shop-api`,
 * and the git panel is on `feat/git-panel`. Two fabrications that disagree read
 * as one of them being broken.
 */

/** One write, and how long to wait after it. */
export type DemoChunk = [text: string, delayMs: number];

const DIM = "\x1b[2m";
const OFF = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

const prompt = (dir: string) => `${CYAN}~/code/${dir}${OFF} ${DIM}$${OFF} `;

/**
 * What the pane has already been through when you arrive, and then a few
 * seconds of it still working.
 *
 * The scrollback is painted at once and the tail is typed, because a terminal
 * that is entirely still is indistinguishable from a screenshot of one, and a
 * terminal that types its whole history from scratch keeps a visitor waiting to
 * read something that was supposed to be already there.
 */
export function demoTermScript(): DemoChunk[] {
  const past = [
    `${prompt("shop-api")}bun test test/checkout.test.ts`,
    ``,
    `${DIM}bun test v1.3.9${OFF}`,
    ``,
    `test/checkout.test.ts:`,
    `${GREEN}(pass)${OFF} totals are quantity-aware ${DIM}> two of the same line item${OFF} ${DIM}[3.10ms]${OFF}`,
    `${GREEN}(pass)${OFF} totals are quantity-aware ${DIM}> a discount applies once${OFF} ${DIM}[1.44ms]${OFF}`,
    `${GREEN}(pass)${OFF} totals are quantity-aware ${DIM}> shipping is not discounted${OFF} ${DIM}[0.98ms]${OFF}`,
    `${RED}(fail)${OFF} refunds ${DIM}> a partial refund leaves the order payable${OFF}`,
    ``,
    `  ${RED}error${OFF}: expected ${GREEN}1240${OFF} to be ${RED}1200${OFF}`,
    `      at ${CYAN}test/checkout.test.ts${OFF}:64:5`,
    ``,
    ` ${GREEN}3 pass${OFF}`,
    ` ${RED}1 fail${OFF}`,
    ` ${DIM}12 expect() calls${OFF}`,
    `${DIM}Ran 4 tests across 1 file. [214.00ms]${OFF}`,
    ``,
    `${prompt("shop-api")}git log --oneline -3`,
    `${YELLOW}9f2c1a7${OFF} checkout hardening: qty-aware totals`,
    `${YELLOW}4a1e08b${OFF} refunds: keep the payable amount on a partial`,
    `${YELLOW}2d77c31${OFF} test: a partial refund is not a full one`,
    ``,
  ];

  const tail: DemoChunk[] = [
    [`${prompt("shop-api")}`, 900],
    [`bun test`, 700],
    [`\r\n\r\n${DIM}bun test v1.3.9${OFF}\r\n\r\n`, 500],
    [`test/checkout.test.ts:\r\n`, 260],
    [`${GREEN}(pass)${OFF} totals are quantity-aware ${DIM}> two of the same line item${OFF}\r\n`, 200],
    [`${GREEN}(pass)${OFF} totals are quantity-aware ${DIM}> a discount applies once${OFF}\r\n`, 200],
    [`${GREEN}(pass)${OFF} totals are quantity-aware ${DIM}> shipping is not discounted${OFF}\r\n`, 240],
    [`${GREEN}(pass)${OFF} refunds ${DIM}> a partial refund leaves the order payable${OFF}\r\n`, 420],
    [`\r\n ${GREEN}${BOLD}4 pass${OFF}\r\n ${DIM}0 fail${OFF}\r\n`, 300],
    [`${DIM}Ran 4 tests across 1 file. [198.00ms]${OFF}\r\n\r\n`, 400],
    [`${prompt("shop-api")}`, 0],
  ];

  return [[past.join("\r\n") + "\r\n", 1200], ...tail];
}

/** Anything a Terminal can be asked to do here. Narrowed so a test can drive
 *  the player with a recorder instead of a real xterm and a canvas. */
export interface DemoWritable {
  write(data: string): void;
}

/**
 * Play the canned session into a terminal. Returns a stop function.
 *
 * Stopping matters: the panel mounts and unmounts as views are switched, and a
 * timer chain that outlives its terminal writes into a disposed one — which
 * xterm answers by throwing, from a callback nobody is awaiting.
 */
export function playDemoSession(term: DemoWritable, script: DemoChunk[] = demoTermScript()): () => void {
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const step = () => {
    if (stopped || i >= script.length) return;
    const [text, delay] = script[i++]!;
    term.write(text);
    timer = setTimeout(step, delay);
  };
  step();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
