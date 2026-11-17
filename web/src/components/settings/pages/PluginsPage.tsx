import { SettingsPage } from "../shell/SettingsPage.tsx";
import { PluginsPane } from "../../PluginsPane.tsx";
import type { PageCtx } from "./ctx.ts";

/** Library > Plugins: the master switch, the unboxed-plugins notice and the installed list live in PluginsPane (run-time rows). `focus` opens one plugin (`plugin:<name>`). */
export function PluginsSettingsPage({ c, focus }: { c: PageCtx; focus?: string }) {
  return (
    <SettingsPage
      title="Plugins"
      purpose="Add-ons that read what the app knows. Nothing runs until you switch it on."
      sections={[{ id: "plugins", title: "Plugins", kind: "normal", body: <PluginsPane open={c.open} focus={focus} /> }]}
    />
  );
}
