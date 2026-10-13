import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: {
    entries: ['src/entry.ts', 'src/box/box-main.ts'],
  },
  build: {
    rollupOptions: {
      input: { main: 'index.html', box: 'box.html' },
    },
  },
})
