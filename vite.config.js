import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Deterministic DB-mode builds for Vercel — not reliant on dashboard build-command overrides.
 * Set VERCEL_BUILD_PROFILE=production-db or staging-db (via vercel.*.json build.env),
 * or pass VITE_*_DB_MODE=true directly.
 */
export default defineConfig(() => {
  const profile = process.env.VERCEL_BUILD_PROFILE || ''
  const productionDb =
    process.env.VITE_PRODUCTION_DB_MODE === 'true' || profile === 'production-db'
  const stagingDb =
    process.env.VITE_STAGING_DB_MODE === 'true' || profile === 'staging-db'

  /** @type {import('vite').UserConfig} */
  const config = {
    plugins: [react()],
    server: {
      port: 3333,
      open: true,
      proxy: {
        '/staging-api': {
          target: 'http://localhost:3334',
          changeOrigin: true,
          rewrite: (path) => `/api${path.replace(/^\/staging-api/, '')}`,
        },
        '/production-api': {
          target: 'http://localhost:3336',
          changeOrigin: true,
          rewrite: (path) => `/api${path.replace(/^\/production-api/, '')}`,
        },
      },
    },
  }

  if (productionDb && stagingDb) {
    throw new Error('Invalid build: production-db and staging-db profiles are mutually exclusive')
  }

  if (productionDb) {
    config.define = {
      'import.meta.env.VITE_PRODUCTION_DB_MODE': JSON.stringify('true'),
      'import.meta.env.VITE_PRODUCTION_API_BASE': JSON.stringify('/api/production'),
    }
  } else if (stagingDb) {
    config.define = {
      'import.meta.env.VITE_STAGING_DB_MODE': JSON.stringify('true'),
      'import.meta.env.VITE_STAGING_API_BASE': JSON.stringify('/api/staging'),
    }
  }

  return config
})
