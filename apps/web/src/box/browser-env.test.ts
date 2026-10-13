import 'fake-indexeddb/auto'

import { registerEnvConformance, registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { describe, expect, it } from 'vitest'

import { BrowserExecutionEnv } from './browser-env'
import { IndexedDbFileStore, MemoryFileStore } from './file-store'

const runner = { describe, expect, it }

let databaseCounter = 0
const freshDatabaseName = () => `hangar-test-${Date.now()}-${databaseCounter++}`

registerEnvConformance(runner, 'BrowserExecutionEnv over memory', async use => {
  const env = await BrowserExecutionEnv.open({ id: 'test', cwd: `/work/${crypto.randomUUID()}`, store: new MemoryFileStore() })
  try {
    await use(env)
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT)
  }
})

registerEnvConformance(runner, 'BrowserExecutionEnv over IndexedDB', async use => {
  const store = await IndexedDbFileStore.open(freshDatabaseName())
  const env = await BrowserExecutionEnv.open({ id: 'test', cwd: '/work', store })
  try {
    await use(env)
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT)
    store.close()
  }
})

registerStorageConformance(runner, 'JsonlStorage on BrowserExecutionEnv over IndexedDB', async use => {
  const store = await IndexedDbFileStore.open(freshDatabaseName())
  const env = await BrowserExecutionEnv.open({ id: 'storage', cwd: '/', store })
  const storage = await JsonlStorage.open('/harness', env, BACKGROUND_CONTEXT)
  try {
    await use(storage)
  } finally {
    await storage.close?.(BACKGROUND_CONTEXT)
    store.close()
  }
})

describe('files survive a reload', () => {
  it('a new env over the same IndexedDB sees files, directories and symlinks written by the old one', async () => {
    const name = freshDatabaseName()
    const first = await IndexedDbFileStore.open(name)
    const before = await BrowserExecutionEnv.open({ id: 'a', cwd: '/work', store: first })
    await before.writeFile('notes/a.txt', 'kept', BACKGROUND_CONTEXT)
    await before.exec('mkdir -p out && echo made > out/b.txt && ln -s notes/a.txt link.txt && rm -f gone.txt', undefined, BACKGROUND_CONTEXT)
    first.close()

    const second = await IndexedDbFileStore.open(name)
    const after = await BrowserExecutionEnv.open({ id: 'a', cwd: '/work', store: second })
    expect(await after.readTextFile('notes/a.txt', BACKGROUND_CONTEXT)).toEqual({ ok: true, value: 'kept' })
    expect(await after.readTextFile('out/b.txt', BACKGROUND_CONTEXT)).toEqual({ ok: true, value: 'made\n' })
    expect(await after.readTextFile('link.txt', BACKGROUND_CONTEXT)).toEqual({ ok: true, value: 'kept' })
    second.close()
  })
})
