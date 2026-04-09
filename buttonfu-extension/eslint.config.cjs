const tsParser = require('@typescript-eslint/parser');

module.exports = [
    {
        ignores: ['node_modules/**', 'out/**', '*.vsix']
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'module'
        },
        rules: {
            'no-undef': 'off'
        }
    }
];