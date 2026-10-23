export const TARGET: string;
export const ENGINE_ESBUILD: {
  bundle: true;
  format: "iife";
  minifyWhitespace: true;
  minifyIdentifiers: true;
  minifySyntax: false;
  platform: "browser";
  target: string;
  legalComments: "none";
  write: false;
  logLevel: "silent";
};
export const RECIPE: string;
