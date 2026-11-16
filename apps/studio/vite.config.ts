import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/agent': {
        target: 'http://127.0.0.1:4317',
      },
      '/projects': {
        target: 'http://127.0.0.1:4317',
      },
      '/sessions': {
        target: 'http://127.0.0.1:4317',
      },
      '/settings': {
        target: 'http://127.0.0.1:4317',
      },
    },
  },
});
