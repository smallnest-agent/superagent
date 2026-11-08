import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  outExtensions: () => ({ js: '.mjs', dts: '.d.mts' }),
  outDir: 'lib',
  clean: true,
  dts: false,
})
