import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

export default defineConfig(({ command }) => {
  const nonce = randomBytes(18).toString('base64')
  return {
    main: { plugins: [externalizeDepsPlugin()] },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: {
      resolve: { alias: { '@shared': resolve('src/shared') } },
      html: command === 'serve' ? { cspNonce: nonce } : undefined,
      plugins: [{
        name: 'development-style-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          // Vite injects development CSS into nonce-bearing <style> elements.
          // The production HTML keeps its strict external-only style policy.
          return html.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
            .replace("connect-src 'none'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*")
        }
      }],
      build: { sourcemap: false }
    }
  }
})
