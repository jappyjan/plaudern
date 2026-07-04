// Map the @plaudern/* aliases straight to lib source so Jest transpiles them
// with ts-jest instead of choking on TS inside node_modules symlinks.
const wsRoot = '<rootDir>/../../..';

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'summarization',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@plaudern/contracts$': `${wsRoot}/libs/contracts/src/index.ts`,
    '^@plaudern/persistence$': `${wsRoot}/libs/backend/persistence/src/index.ts`,
    '^@plaudern/inbox$': `${wsRoot}/libs/backend/inbox/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
};
