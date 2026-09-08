import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@tailwindcss/vite';

// Override the origin and base path for alternate deployment environments.
export default defineConfig({
  site: process.env.SITE_URL || 'https://pacifico.emersoftware.cl',
  base: process.env.SITE_BASE || '/',
  trailingSlash: 'always',
  integrations: [react()],
  vite: { plugins: [tailwind()] },
  devToolbar: { enabled: false },
});
