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
    exclude: ['@xgis/compiler', '@xgis/runtime'],
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        demo: 'demo.html',
      },
    },
  },
})
