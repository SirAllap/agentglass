import { describe, expect, it } from "bun:test";
import { dedupePeople, personKey, subline } from "../src/lib/personRow.ts";

/* Two accounts that look like one person: a tracker account with a display name
   and an email, and a GitHub account whose login is the same word. */
const ada = { id: 38134814, name: "Ada Dev", email: "ada.dev@acme.test", source: "ClickUp" as const };
const adadev = { id: "adadev", name: "adadev", login: "adadev", source: "GitHub" as const };

describe("personKey", () => {
  it("is the account id when the source has one", () => expect(personKey({ id: 7 })).toBe("id:7"));
  it("is the login when that is all there is, whatever its case", () =>
    expect(personKey({ id: "x", login: "AdaDev" })).toBe(personKey({ id: "y", login: "adadev" })));
  it("is never the email", () => expect(personKey({ id: 1, email: "a@acme.test" })).not.toBe(personKey({ id: 2, email: "a@acme.test" })));
});

describe("dedupePeople", () => {
  it("two accounts keep two rows", () => expect(dedupePeople([ada, adadev]).length).toBe(2));

  it("the same account once", () =>
    expect(dedupePeople([ada, { ...ada, name: "Ada D." }]).map((p) => p.name)).toEqual(["Ada Dev"]));

  it("the same GitHub login once", () =>
    expect(dedupePeople([adadev, { ...adadev, email: "other@acme.test" }]).length).toBe(1));

  it("two accounts that share an email stay two: an email is not an id", () => {
    const a = { id: 1, name: "Ada Dev", email: "team@acme.test" };
    const b = { id: 2, name: "Ada D.", email: "team@acme.test" };
    expect(dedupePeople([a, b]).length).toBe(2);
  });

  it("keeps the source's order", () => expect(dedupePeople([ada, adadev]).map((p) => p.name)).toEqual(["Ada Dev", "adadev"]));
});

describe("subline", () => {
  it("shows the email under the name", () => expect(subline(ada)).toBe("ada.dev@acme.test"));

  it("two rows with different emails read as two people", () => {
    const rows = [subline(ada), subline({ id: 2, email: "ada@acme.test", source: "Jira" })];
    expect(rows[0]).not.toBe(rows[1]);
    expect(rows.every((r) => r.includes("@acme.test"))).toBe(true);
  });

  it("without an email, the login and the source", () => {
    expect(subline({ id: "adadev", login: "adadev", source: "GitHub" })).toBe("@adadev · GitHub");
  });

  it("without an email or a login, the source alone — never an empty line", () => {
    expect(subline({ id: 3, source: "Jira" })).toBe("Jira");
  });

  it("keeps what the row already had to say, once", () => {
    expect(subline({ id: 1, email: "ada@acme.test", sub: "approved" })).toBe("ada@acme.test · approved");
    expect(subline({ id: "adadev", login: "adadev", source: "GitHub", sub: "@adadev" })).toBe("@adadev · GitHub");
  });
});
