/** Which build this is: the version in package.json, the number of the deploy that made it (for a build made by GitHub), the commit, and where it was made for. See vite.config.ts. */
export interface AppVersion {
  /** `version` in package.json: changed by hand for a release. */
  version: string;
  /** The number of the deploy run that built it; empty for a build made on a machine. */
  build: string;
  /** The first characters of the commit it was built from ('' if that was not known; a '+' says there were changes that were not committed). */
  commit: string;
  /** `dev`, `prod` (what the deploy was for) or `local`. */
  stage: string;
  /** When it was built (ISO 8601). */
  built: string;
}

export function appVersion(): AppVersion {
  return { version: __APP_VERSION__, build: __APP_BUILD__, commit: __APP_COMMIT__, stage: __APP_STAGE__, built: __APP_BUILT__ };
}

/** A short line for a corner of the screen: "v0.1.0 · build 57 · a1b2c3d" (and the stage, unless it is the real one). */
export function versionLabel(v: AppVersion = appVersion()): string {
  const parts = [`v${v.version}`];
  if (v.build) parts.push(`build ${v.build}`);
  if (v.commit) parts.push(v.commit);
  if (v.stage && v.stage !== 'prod') parts.push(v.stage);
  return parts.join(' · ');
}
