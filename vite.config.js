import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { apiChatDevPlugin } from './vite.api-chat-dev.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), apiChatDevPlugin(env)],
  }
})
