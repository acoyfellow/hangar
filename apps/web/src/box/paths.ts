export const normalizePath = (path: string): string => {
  const segments: Array<string> = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

export const resolveAgainst = (cwd: string, path: string): string => {
  const withoutScheme = path.startsWith('file://') ? path.slice('file://'.length) : path
  return normalizePath(withoutScheme.startsWith('/') ? withoutScheme : `${cwd}/${withoutScheme}`)
}

export const joinPaths = (parts: ReadonlyArray<string>): string => {
  const joined = parts.filter(part => part !== '').join('/')
  const normalized = normalizePath(joined)
  return joined.startsWith('/') ? normalized : normalized.slice(1) || '.'
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export const isWithin = (path: string, ancestor: string): boolean =>
  ancestor === '/' ? path !== '/' : path.startsWith(`${ancestor}/`)
