// Conventional Commits, matching the repo's existing style
// (feat / fix / perf / refactor / test / docs / chore / build / ci …).
// Enforced by the Husky commit-msg hook. Subjects here run long (the repo
// favours descriptive one-liners), so the length caps are relaxed/disabled.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'chore', 'build', 'ci', 'style', 'revert'],
    ],
    // The repo scopes by subsystem, e.g. `fix(map): …`, `refactor(engine): …`.
    'scope-empty': [0],
    'subject-case': [0],
    'header-max-length': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
}
