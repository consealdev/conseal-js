import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        hookTimeout: 60_000,
        testTimeout: 60_000,
        projects: [
            {
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['test/core/**/*.test.ts', 'test/sync/**/*.test.ts'],
                    setupFiles: ['./test/support/setup.ts'],
                },
            },
            {
                // Core in each browser engine: WebCrypto differs between them.
                test: {
                    name: 'browser',
                    include: ['test/core/**/*.test.ts'],
                    browser: {
                        enabled: true,
                        provider: playwright(),
                        headless: true,
                        screenshotFailures: false,
                        instances: [
                            { browser: 'chromium' },
                            { browser: 'firefox' },
                            { browser: 'webkit' },
                        ],
                    },
                },
            },
        ],
    },
});
