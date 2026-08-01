import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
};

/**
 * Claude spawns this as its own process for permission prompts, so it cannot
 * live inside the extension bundle.
 */
/** @type {import('esbuild').BuildOptions} */
const permissionServerConfig = {
  entryPoints: ['src/permission/mcpServer.ts'],
  bundle: true,
  outfile: 'dist/permissionServer.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview/main.tsx'],
  bundle: true,
  outfile: 'media/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: !production,
  minify: production,
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(permissionServerConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[usturlab] watching...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(permissionServerConfig),
    esbuild.build(webviewConfig),
  ]);
  console.log('[usturlab] build complete');
}
