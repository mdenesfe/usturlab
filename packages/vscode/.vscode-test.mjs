import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test/**/*.test.js',
  version: 'stable',
  mocha: { timeout: 60_000 },
});
