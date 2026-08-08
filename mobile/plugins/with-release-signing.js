/*
 * Where the release APK's signature comes from — and where it deliberately
 * does not.
 *
 * Android will not install an unsigned APK, so "signed" is not a polish step,
 * it is the difference between a file and an app. The template Expo generates
 * signs `release` with the DEBUG keystore that it checks into `android/app/`:
 *
 *     release {
 *         // Caution! In production, you need to generate your own keystore
 *         signingConfig signingConfigs.debug
 *
 * That is fine for handing somebody an APK to try, and wrong for anything
 * anybody installs on purpose. Everyone who has ever run `expo prebuild` has
 * that same key, so a debug-signed build is not evidence it came from us, and
 * Play refuses it outright. The trap is that it never fails — the file builds,
 * installs and runs, and the only symptom is a signature nobody looks at.
 *
 * ── why a config plugin and not an edit ──────────────────────────────────
 * `android/` is generated and gitignored (see mobile/.gitignore); the workflow
 * regenerates it from app.json on every build. An edit to app/build.gradle
 * would survive exactly until the next prebuild, which is to say it would work
 * on the laptop where it was made and nowhere else. A plugin runs INSIDE
 * prebuild, so the generated tree already carries it.
 *
 * ── what this does NOT do ────────────────────────────────────────────────
 * It does not create a keystore. A release keystore is a secret with no
 * recovery — lose it and the app can never be updated under that identity
 * again, by anybody — so whoever owns the app makes it, decides where it
 * lives, and decides who holds the passwords. Nothing here generates one,
 * writes one, or reads one out of the repository.
 *
 * What it does is leave the door fitted: if the four values below are present
 * at build time, the release APK is signed with that key. If they are absent
 * the build still succeeds, still signs with the debug key, and says so in the
 * Gradle log — because a release job that silently fails to be a release is
 * the failure mode this whole file exists to avoid. mobile/README.md ("Signing
 * a release build") is the other half.
 *
 *   AGENTGLASS_ANDROID_KEYSTORE            path to the .jks / .keystore
 *   AGENTGLASS_ANDROID_KEYSTORE_PASSWORD   store password
 *   AGENTGLASS_ANDROID_KEY_ALIAS           alias inside the store
 *   AGENTGLASS_ANDROID_KEY_PASSWORD        key password
 */
const { withAppBuildGradle } = require("@expo/config-plugins");

/** The template's debug signingConfig, verbatim, and the closing braces of the
 *  `signingConfigs { … }` block it is the only member of. Anchored on all four
 *  lines rather than on `}\n    }`, which occurs a dozen times in the file. */
const AFTER_DEBUG_CONFIG = `            keyPassword 'android'
        }
    }`;

/** Read once into locals so the ternary below and the config agree about what
 *  "configured" means. `findProperty` covers ~/.gradle/gradle.properties, which
 *  is how somebody signs from a laptop without putting a secret in an env var
 *  that ends up in shell history. */
const RELEASE_CONFIG = `            keyPassword 'android'
        }
        release {
            // Absent on purpose until somebody sets them — see
            // mobile/plugins/with-release-signing.js for why this file does not
            // create a keystore.
            def ksPath = System.getenv("AGENTGLASS_ANDROID_KEYSTORE") ?: project.findProperty("agentglassKeystore")
            if (ksPath) {
                storeFile file(ksPath)
                storePassword System.getenv("AGENTGLASS_ANDROID_KEYSTORE_PASSWORD") ?: project.findProperty("agentglassKeystorePassword")
                keyAlias System.getenv("AGENTGLASS_ANDROID_KEY_ALIAS") ?: project.findProperty("agentglassKeyAlias")
                keyPassword System.getenv("AGENTGLASS_ANDROID_KEY_PASSWORD") ?: project.findProperty("agentglassKeyPassword")
            }
        }
    }`;

/** The template's release buildType, whose first line is the one being replaced. */
const DEBUG_SIGNED_RELEASE = `        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

const CHOSEN_SIGNING = `        release {
            // Which key signs this is decided here rather than in a comment, and
            // announced either way: an APK that quietly carries the shared debug
            // key looks identical to a properly signed one until Play rejects it.
            def ksPath = System.getenv("AGENTGLASS_ANDROID_KEYSTORE") ?: project.findProperty("agentglassKeystore")
            if (ksPath) {
                logger.lifecycle("agentglass: signing release with " + ksPath)
                signingConfig signingConfigs.release
            } else {
                logger.lifecycle("agentglass: no release keystore configured — signing release with the DEBUG key. Installable, not publishable. See mobile/README.md.")
                signingConfig signingConfigs.debug
            }`;

/**
 * Both edits, or an error.
 *
 * A plugin that cannot find its anchor and shrugs is worse than no plugin: the
 * build goes green and ships a debug-signed "release" while a file in the repo
 * claims otherwise. Expo's template is the thing that moves here, and it moves
 * on its own schedule, so the failure has to be loud enough to be fixed in the
 * same sitting.
 */
const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error(
        "with-release-signing: app/build.gradle is not Groovy any more — the anchors below are text, and they need rewriting for whatever replaced it.",
      );
    }
    let src = cfg.modResults.contents;

    if (src.includes("signingConfigs.release")) return cfg; // already applied

    for (const [needle, replacement] of [
      [AFTER_DEBUG_CONFIG, RELEASE_CONFIG],
      [DEBUG_SIGNED_RELEASE, CHOSEN_SIGNING],
    ]) {
      if (!src.includes(needle)) {
        throw new Error(
          `with-release-signing: could not find this in the generated app/build.gradle:\n${needle}\n` +
            "Expo's template changed. Re-anchor it — do NOT ship a release signed with the debug key.",
        );
      }
      src = src.replace(needle, replacement);
    }

    cfg.modResults.contents = src;
    return cfg;
  });

module.exports = withReleaseSigning;
