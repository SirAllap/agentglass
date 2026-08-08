/*
 * Metro, taught that this app is not the whole repository.
 *
 * One directory above itself, now: `shared/`. That is the wire — `types.ts` is
 * what the server compiles against, so a field that changes shape on one side
 * stops type-checking on the other — plus the two rules both surfaces have to
 * agree on, `projectKey.ts` and `sessionTitle.ts`.
 *
 * `web/src` used to be watched too, because this app imported the browser
 * companion's model layer rather than copying it: which cards the queue shows,
 * how a chat list is assembled, which pull-request rows are the same one. That
 * companion is deleted — it could never pair over a LAN, since `crypto.subtle`
 * exists only in a secure context and `http://192.168.x.x` is not one — and the
 * five modules that were worth keeping now live in `src/model/`, with their
 * tests in `test/`. `src/model/` is pure decisions over server payloads: no
 * React, no `fetch`, no storage. `src/lib/` is the half that touches the
 * outside world. The split is what lets the whole queue be tested by `bun test`
 * without a device.
 *
 * Metro's project root is this directory and it refuses to read a file above
 * it, so without `watchFolders` an import of `../../shared/...` resolves at
 * type-check time (tsc has no such rule) and then fails at bundle time, which
 * is the worst place to find out.
 *
 * `nodeModulesPaths` stays pinned to this app's own: the repository root
 * installs a Bun workspace for the server and the dashboard, and letting Metro
 * walk into it would put a second copy of React in the bundle.
 */
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.join(repoRoot, "shared")];

/*
 * Stand-ins for the native modules, on the WEB target only.
 *
 * The web build is not a product — Android is. It exists so the app can be RUN
 * during development: loaded in a real browser, walked through every screen,
 * and read for errors. Without it the first thing to execute this code is a
 * phone, and the first person to see a screen fail is whoever is holding one.
 *
 * Every one of these has no web implementation at all (expo-secure-store's is
 * literally `export default {}`), so without the swap the harness stops at the
 * first screen and proves only that the app boots.
 *
 * Scoped to `platform === "web"`, so nothing here can reach the Android bundle.
 */
const WEB_SHIMS = {
  "expo-secure-store": "./src/web-shims/secure-store.ts",
  "expo-notifications": "./src/web-shims/notifications.ts",
  "expo-haptics": "./src/web-shims/haptics.ts",
  "expo-clipboard": "./src/web-shims/clipboard.ts",
  "react-native-webview": "./src/web-shims/webview.tsx",
  "expo-camera": "./src/web-shims/camera.tsx",
};

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const shim = platform === "web" ? WEB_SHIMS[moduleName] : undefined;
  if (shim) {
    return context.resolveRequest(context, path.resolve(projectRoot, shim), platform);
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
