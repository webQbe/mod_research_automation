import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { 
    port: 3000,
    proxy: {
      // Directs any request starting with /api to the backend
      '/api/run-scrape': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
      },
      '/api/run-bulk': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})