const wsRoot = '<rootDir>/../..';

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'web',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@plaudern/contracts$': `${wsRoot}/libs/contracts/src/index.ts`,
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
};
