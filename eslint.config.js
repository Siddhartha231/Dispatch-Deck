// ESLint is intentionally minimal: TypeScript (`npm run type-check`) and
// Prettier (`npm run format:check`) cover types and style. The one rule here,
// react-hooks/rules-of-hooks, catches conditional hook calls before they ship
// as an opaque "Minified React error #310". vite-plugin-checker also runs it
// during builds.
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.wrangler/**', '.vite/**', '.deepspace/**', '**/._*'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
]
