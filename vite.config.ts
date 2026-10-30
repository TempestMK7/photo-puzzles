import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** The commit the build is made from: what the deploy says (GITHUB_SHA), else git, with a '+' if the files differ from it (a build made on a machine). */
function commit(): string {
  const given = process.env.GITHUB_SHA ?? process.env.VITE_COMMIT;
  if (given) return given.slice(0, 7);
  try {
    const sha = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return sha + (dirty ? '+' : '');
  } catch {
    return '';
  }
}

// base './' so the build also works from an itch.io page, a Capacitor web view or a desktop shell.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  // which build this is, shown on the main screen (src/version.ts); the deploy workflow gives the run number and the stage
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(process.env.VITE_BUILD ?? ''),
    __APP_COMMIT__: JSON.stringify(commit()),
    __APP_STAGE__: JSON.stringify(process.env.VITE_STAGE ?? 'local'),
    __APP_BUILT__: JSON.stringify(new Date().toISOString()),
  },
  // infra/ is a project of its own (the CDK, its own node_modules and its own `npm test`)
  test: { exclude: [...configDefaults.exclude, 'infra/**'] },
});
