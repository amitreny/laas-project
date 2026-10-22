import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Forward API calls and the terminal WebSocket to the Fastify server.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
});
