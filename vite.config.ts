import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Electron loads the production renderer through file://, so assets must be
// relative to dist/index.html rather than rooted at file:///.
export default defineConfig({ base: './', plugins: [react()] });
