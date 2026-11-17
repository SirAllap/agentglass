// A person with no picture: Gravatar redirects to its own image proxy with
// the Atlassian initials image as the path. That hop was refused, and every
// initials avatar on a board answered 400 "blocked".
import { expect, test } from "bun:test";
import { assetAllowed, avatarRedirect } from "../src/prs.ts";

const atl = "avatar-management--avatars.us-west-2.prod.public.atl-paas.net";
const first = new URL(`https://secure.gravatar.com/avatar/0123456789abcdef0123456789abcdef?d=${encodeURIComponent(`https://${atl}/initials/AB-2.png`)}`);

test("the request the window makes is allowed in the first place", () => {
  expect(assetAllowed(first.toString())?.hostname).toBe("secure.gravatar.com");
});

test("the proxy hop is followed to the image it names, never to the proxy", () => {
  const next = avatarRedirect(first, `https://i2.wp.com/${atl}/initials/AB-2.png?ssl=1`);
  expect(next?.toString()).toBe(`https://${atl}/initials/AB-2.png`);
});

test("a direct hop to an avatar host still works", () => {
  expect(avatarRedirect(first, `https://${atl}/initials/AB-2.png`)?.hostname).toBe(atl);
});

test("the proxy opens nothing else", () => {
  for (const location of [
    "https://i2.wp.com/example.com/initials/AB-2.png?ssl=1",
    `https://i2.wp.com.example.com/${atl}/initials/AB-2.png`,
    `https://example.com/${atl}/initials/AB-2.png`,
    `http://i2.wp.com/${atl}/initials/AB-2.png`,
    `https://i2.wp.com/user:pw@${atl}/initials/AB-2.png`,
    `https://i2.wp.com/${atl}:8443/initials/AB-2.png`,
    `https://i2.wp.com/${atl}.example.com/initials/AB-2.png`,
    "https://i2.wp.com/",
  ]) expect(avatarRedirect(first, location), location).toBeNull();
});
