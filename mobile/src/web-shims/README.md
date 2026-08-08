Stand-ins for the native modules, used by the WEB target only.

The web build is not a product — Android is. It exists so the app can be RUN
here: loaded in a real browser, walked through every screen, and read for
errors. Without it the first thing to ever execute this code is a phone, and
the first person to see it fail is whoever is holding one.

Metro swaps these in for `platform === "web"` (see metro.config.js). Nothing
here ships in the Android bundle, and each one is the smallest thing that lets
the screen above it render rather than a pretend implementation:

  secure-store   localStorage, so the harness can seed a paired host
  webview        a box that says what it would have been
  camera         the same, plus the permission hook the pairing screen calls
  notifications  no-ops that resolve, because "granted" is the interesting path
  haptics        no-ops
