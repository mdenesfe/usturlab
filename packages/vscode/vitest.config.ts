import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // The host supplies `vscode` at runtime and it cannot be installed, so
      // anything under test that imports it gets the stub instead.
      vscode: fileURLToPath(new URL('./test/unit/vscodeStub.ts', import.meta.url)),
    },
  },
});
