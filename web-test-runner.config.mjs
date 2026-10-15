// The components' tests, in a real Chromium: shadow DOM, custom elements and WebCrypto as a browser has them.
import { esbuildPlugin } from '@web/dev-server-esbuild';
import { playwrightLauncher } from '@web/test-runner-playwright';
import { fileURLToPath } from 'node:url';

export default {
    files: 'test/ui/**/*.test.ts',
    nodeResolve: true,
    // The tsconfig carries the legacy decorators that lit's @property needs.
    plugins: [esbuildPlugin({ ts: true, tsconfig: fileURLToPath(new URL('./tsconfig.json', import.meta.url)) })],
    browsers: [playwrightLauncher({ product: 'chromium' })],
    testFramework: { config: { timeout: 30_000 } },
};
