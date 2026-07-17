import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^backend\/(.+)$/, replacement: path.join(projectRoot, 'src/backend/$1') },
      { find: 'wix-data', replacement: path.join(projectRoot, 'tests/mocks/wix-data.js') },
      { find: 'wix-auth', replacement: path.join(projectRoot, 'tests/mocks/wix-auth.js') },
      { find: 'wix-ecom-backend', replacement: path.join(projectRoot, 'tests/mocks/wix-ecom-backend.js') },
      { find: 'wix-fetch', replacement: path.join(projectRoot, 'tests/mocks/wix-fetch.js') },
      { find: 'wix-http-functions', replacement: path.join(projectRoot, 'tests/mocks/wix-http-functions.js') },
      { find: 'wix-secrets-backend', replacement: path.join(projectRoot, 'tests/mocks/wix-secrets-backend.js') },
    ],
  },
  test: {
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
