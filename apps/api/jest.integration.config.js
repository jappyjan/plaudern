// Runs the Testcontainers-backed integration suite (real Postgres/MinIO/Redis).
// Separate from the fast unit config so `nx test api` stays quick and infra-free.
const wsRoot = '<rootDir>/../..';

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'api-integration',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/*.integration-spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // Order matters: the specific contracts mapping must precede the generic
    // backend-libs pattern.
    '^@plaudern/contracts$': `${wsRoot}/libs/contracts/src/index.ts`,
    '^@plaudern/([^/]+)$': `${wsRoot}/libs/backend/$1/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  testTimeout: 180000,
  // containers need an orderly shutdown; surface leaks in CI
  detectOpenHandles: false,
};
