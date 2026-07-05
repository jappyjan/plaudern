// Runs the AI extraction quality evals (JJ-1). Kept in its own config, matching
// only `*.eval.ts`, so the golden-set quality gate is a distinct signal from the
// fast unit suite (`*.spec.ts`) and can be run on its own via `nx run evals:eval`.
//
// The evals never touch a live LLM: each fixture carries a RECORDED model
// response, which is fed through the real deterministic parse/normalize/resolve
// code paths (the post-LLM code where regressions actually live) and scored for
// precision/recall against a human-labeled golden set.
const wsRoot = '<rootDir>/../../..';

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'evals',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/*.eval.ts'],
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
};
