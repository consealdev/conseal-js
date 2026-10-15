import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        hookTimeout: 60_000,
        testTimeout: 60_000,
        projects: [
            {
                extends: true,
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['test/core/**/*.test.ts', 'test/sync/**/*.test.ts'],
                    setupFiles: ['./test/support/setup.ts'],
                },
            },
            // Core and the components in each browser engine: WebCrypto differs between them.
            {
                extends: true,
                test: {
                    name: 'browser',
                    include: ['test/core/**/*.test.ts', 'test/ui/**/*.test.ts'],
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
