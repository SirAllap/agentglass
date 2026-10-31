/**
 * Is this volume a node_modules volume, by its name?
 *
 * Only the compose-style suffix counts: `orbit_node_modules_backup` is
 * somebody's data. The web view and the server's remove route read the same
 * test, so the button and the refusal cannot disagree about what may go.
 */
export const isNodeModulesVolume = (name: string): boolean => /(?:^|[_-])node_modules$/.test(name);
