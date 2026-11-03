// Imported first in main.tsx: whether this machine has prior state is only
// knowable before the rest of the app has written anything of its own.
import { settlePaneBarMode } from "./paneActionsPref.ts";
settlePaneBarMode();
