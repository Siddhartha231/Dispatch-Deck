import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import checker from 'vite-plugin-checker'
import { deepspaceBuild } from 'deepspace/build'

const appDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    // Inspector debugging is optional; disabling it avoids a network-interface
    // probe that restricted containers reject.
    cloudflare({ inspectorPort: false }),
    // Injects the app id from wrangler.toml and the SDK's client build hints.
    deepspaceBuild({ appDir }),
    // Fails the build on a Rules of Hooks violation (see eslint.config.js).
    checker({ eslint: { lintCommand: 'eslint .', useFlatConfig: true } }),
  ],
})
