import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// Build estático servido por nginx; en dev el proxy apunta a NestJS.
export default defineConfig({
  output: 'static',
  outDir: './dist',
  integrations: [react()],
  server: { port: 4321 },
  vite: {
    plugins: [tailwindcss()],
    server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  },
});
