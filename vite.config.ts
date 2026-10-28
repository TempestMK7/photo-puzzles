import { configDefaults, defineConfig } from 'vitest/config';

// base './' so the build also works from an itch.io page, a Capacitor web view or a desktop shell.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  // infra/ is a project of its own (the CDK, its own node_modules and its own `npm test`)
  test: { exclude: [...configDefaults.exclude, 'infra/**'] },
});
