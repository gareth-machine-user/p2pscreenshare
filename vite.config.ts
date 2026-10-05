import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // Relative asset paths so the build works under a GitHub Pages project subpath (/<repo>/).
  base: './',
})
