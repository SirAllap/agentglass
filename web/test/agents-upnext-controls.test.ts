/*
 * UP NEXT KEEPS TWO CONTROLS the old screens had: a last queue row that puts a
 * task on the coordinator's list, and a quiet "Schedule…" in the header that
 * opens the schedule dialog. A rule about source is asserted against source.
 */
import { expect, test } from "bun:test";

const sections = await Bun.file(new URL("../src/components/agents/AgentsSections.tsx", import.meta.url)).text();
const view = await Bun.file(new URL("../src/components/agents/AgentsView.tsx", import.meta.url)).text();
const upNext = sections.slice(sections.indexOf("export function UpNext("));
const addRow = sections.slice(sections.indexOf("function AddTaskRow("), sections.indexOf("export function UpNext("));

test("the add row is a queue row that posts the title and the done-when through seatTaskAdd", () => {
  expect(addRow).toContain('className="qr qadd"');
  expect(addRow).toContain('name="plus"');
  expect(addRow).toContain("Add a task for the coordinator");
  expect(addRow).toContain("api.seatTaskAdd(root, t, proof.trim())");
  expect(addRow).toMatch(/title\.trim\(\) && <input[\s\S]*?done when…/);
});

test("the queue card ends with the add row", () => {
  expect(upNext).toContain("{addRow}\n            </div>");
  expect(upNext).toContain("<AddTaskRow");
});

test("the header has a quiet Schedule… button that opens the dialog", () => {
  expect(upNext).toMatch(/<SectionHead title="Up next"[\s\S]*?className="btn sm quiet" onClick=\{onSchedule\}[^>]*>Schedule…<\/button>/);
  expect(view).toContain("onSchedule={() => setScheduling(true)}");
  expect(view).toContain('takeViewModal("lantern.schedule")');
});

test("the add row has a submit button, or Enter does nothing once there are two fields", () => {
  expect(addRow).toContain('<button type="submit" hidden');
});
