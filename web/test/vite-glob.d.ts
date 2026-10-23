// The suites are typed against bun-types, not vite/client (see tsconfig.test.json), and a few
// components they import reach for Vite's `import.meta.glob`. Only that one member, and only here.
interface ImportMeta {
  glob(pattern: string, options?: { eager?: boolean; query?: string; import?: string }): Record<string, unknown>;
}
