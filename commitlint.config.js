/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'web',
        'extension',
        'worker',
        'db',
        'shared',
        'sdk',
        'storage',
        'ai',
        'retrieval',
        'docker',
        'docs',
        'evals',
        'ci',
        'deps',
        'repo',
      ],
    ],
  },
};
