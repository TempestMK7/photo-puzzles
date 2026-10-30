import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import { LEGAL_FILES, renderLegal } from './src/legal/html';

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

/**
 * The privacy policy and the terms are pages of their own (privacy.html, terms.html: no script, nothing to load but a style sheet), with their text put in when they are built. Who runs
 * the game, where to write and the law come from the deploy (LEGAL_OPERATOR, LEGAL_CONTACT, LEGAL_LAW: repository variables), so that none of it is in this public repository.
 */
function legalPages(): Plugin {
  const values = { operator: process.env.LEGAL_OPERATOR ?? '', contact: process.env.LEGAL_CONTACT ?? '', law: process.env.LEGAL_LAW ?? '' };
  return {
    name: 'legal-pages',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = ctx.path.replace(/^\//, '');
        if (!(file in LEGAL_FILES)) return html;
        const page = renderLegal(file as keyof typeof LEGAL_FILES, values);
        return html.replace('<!--title-->', () => page.title).replace('<!--legal-->', () => page.html);
      },
    },
  };
}

// base './' so the build also works from an itch.io page, a Capacitor web view or a desktop shell.
export default defineConfig({
  base: './',
  plugins: [legalPages()],
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)), terms: fileURLToPath(new URL('./terms.html', import.meta.url)) } },
  },
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
