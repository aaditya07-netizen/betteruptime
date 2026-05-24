import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Read .dockerignore from the monorepo root
const dockerignore = readFileSync(join(process.cwd(), '.dockerignore'), 'utf8');

/**
 * Validates: Requirements 1.1, 1.3
 *
 * Requirement 1.1: The .dockerignore file SHALL exclude node_modules, .git,
 * .turbo, dist, .next, *.log, .env*, and all *.pid files from the Docker
 * build context.
 *
 * Requirement 1.3: The .dockerignore file SHALL exclude the .codex-runtime
 * directory from the build context.
 */
describe('Feature: docker-containerization — .dockerignore patterns', () => {
  const requiredPatterns = [
    'node_modules',
    '.git',
    '.turbo',
    'dist',
    '.next',
    '*.log',
    '.env',
    '*.pid',
    '.codex-runtime',
  ];

  for (const pattern of requiredPatterns) {
    it(`contains pattern: ${pattern}`, () => {
      assert.ok(
        dockerignore.includes(pattern),
        `Expected .dockerignore to contain "${pattern}"`
      );
    });
  }
});
