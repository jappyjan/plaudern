// Map the @plaudern/* aliases straight to lib source so Jest transpiles them
// with ts-jest instead of choking on TS inside node_modules symlinks.
const wsRoot = '<rootDir>/../../..';

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'persistence',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@plaudern/contracts$': `${wsRoot}/libs/contracts/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
};
