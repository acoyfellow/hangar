export type StoredEntry =
  | { readonly path: string; readonly type: 'file'; readonly content: Uint8Array; readonly mode: number }
  | { readonly path: string; readonly type: 'directory'; readonly mode: number }
  | { readonly path: string; readonly type: 'symlink'; readonly target: string }

export type StoreChange =
  | { readonly kind: 'put'; readonly entry: StoredEntry }
  | { readonly kind: 'delete'; readonly path: string }

export interface FileStore {
  load(): Promise<ReadonlyArray<StoredEntry>>
  apply(changes: ReadonlyArray<StoreChange>): Promise<void>
}

export class MemoryFileStore implements FileStore {
  readonly entries = new Map<string, StoredEntry>()

  async load(): Promise<ReadonlyArray<StoredEntry>> {
    return [...this.entries.values()]
  }

  async apply(changes: ReadonlyArray<StoreChange>): Promise<void> {
    for (const change of changes) {
      if (change.kind === 'put') this.entries.set(change.entry.path, change.entry)
      else this.entries.delete(change.path)
    }
  }
}

const OBJECT_STORE = 'files'

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })

export class IndexedDbFileStore implements FileStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(name: string, factory: IDBFactory = indexedDB): Promise<IndexedDbFileStore> {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(OBJECT_STORE, { keyPath: 'path' })
    }
    return new IndexedDbFileStore(await requestResult(request))
  }

  async load(): Promise<ReadonlyArray<StoredEntry>> {
    const transaction = this.database.transaction(OBJECT_STORE, 'readonly')
    return requestResult(transaction.objectStore(OBJECT_STORE).getAll() as IDBRequest<Array<StoredEntry>>)
  }

  async apply(changes: ReadonlyArray<StoreChange>): Promise<void> {
    if (changes.length === 0) return
    const transaction = this.database.transaction(OBJECT_STORE, 'readwrite')
    const store = transaction.objectStore(OBJECT_STORE)
    for (const change of changes) {
      if (change.kind === 'put') store.put(change.entry)
      else store.delete(change.path)
    }
    await transactionDone(transaction)
  }

  close(): void {
    this.database.close()
  }
}
