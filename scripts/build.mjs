import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.js'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
});
