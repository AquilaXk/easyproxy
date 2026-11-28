/**
 * Environment for `ps` calls whose `lstart` output is parsed or compared. `ps` prints the start
 * time in the user's locale (for example Korean), which `Date.parse` and the fixed-layout
 * regexes cannot read, and which differs between a CLI and a service started under another locale.
 */
export function cLocaleEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", ...extra };
}
