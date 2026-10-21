import { defineConfig } from 'vite';

// base './' so the build also works from an itch.io page, a Capacitor web view or a desktop shell.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
