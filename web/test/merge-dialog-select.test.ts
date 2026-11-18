import { expect, test } from "bun:test";

const dialog = await Bun.file(new URL("../src/components/MergeDialog.tsx", import.meta.url)).text();
const select = await Bun.file(new URL("../src/components/Select.tsx", import.meta.url)).text();

// A className on Select replaces its own classes, so a bare size class left the tracker card's
// status picker a naked button: grey box round the pill, caret in a black square.
test("the merge dialog's card status picker is Select's own trigger, no box of its own", () => {
  const at = dialog.indexOf('title="Where this card goes when the merge lands"');
  expect(at).toBeGreaterThan(-1);
  const props = dialog.slice(at, dialog.indexOf("options={[", at));
  expect(props).not.toContain("className=");
  expect(props).not.toContain("borderColor");
});

test("Select's trigger names itself with the house tooltip, never the native one", () => {
  const button = select.slice(select.indexOf("<button"), select.indexOf("</button>"));
  expect(button).toContain("data-tip={title}");
  expect(button).not.toContain("title={title}");
});
