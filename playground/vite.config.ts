import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    port: 3000,
    host: true,
    watch: { followSymlinks: true },
  },
  optimizeDeps: {
    // Don't pre-bundle workspace packages — use source directly
    exclude: ['@xgis/compiler', '@xgis/runtime'],
  },
})
