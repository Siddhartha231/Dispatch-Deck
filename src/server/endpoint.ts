// The hosted starter route templates call these helpers, which SDK 0.44.1 does not export.
export function lookupOwn<T>(entries: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(entries, name) ? entries[name] : undefined
}
export function integrationPath(name: string, endpoint: string) {
  const valid = (value: string) => /^[a-z0-9][a-z0-9_-]{0,100}$/.test(value)
  return valid(name) && valid(endpoint) ? '/api/integrations/' + name + '/' + endpoint : null
}
