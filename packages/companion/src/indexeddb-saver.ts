import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  writesSortKey,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

const CHECKPOINTS = "checkpoints";
const WRITES = "writes";
const DEFAULT_DB_NAME = "browser-agent-companion";

type CheckpointKey = [thread: string, ns: string, checkpointId: string];
type CheckpointRecord = { checkpoint: Uint8Array; metadata: Uint8Array; parentCheckpointId?: string };
type WriteKey = [thread: string, ns: string, checkpointId: string, taskId: string, idx: number];
type WriteRecord = { channel: string; value: Uint8Array; taskPath: string };
type Row<K, V> = { key: K; value: V };

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CHECKPOINTS);
      req.result.createObjectStore(WRITES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function transact(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => void,
): Promise<void> {
  const tx = db.transaction(storeName, mode);
  fn(tx.objectStore(storeName));
  return finished(tx);
}

function getOne<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function scan<K, V>(
  db: IDBDatabase,
  storeName: string,
  range: IDBKeyRange | null,
  direction: IDBCursorDirection = "next",
  limit = Infinity,
): Promise<Row<K, V>[]> {
  return new Promise((resolve, reject) => {
    const out: Row<K, V>[] = [];
    const req = db.transaction(storeName, "readonly").objectStore(storeName).openCursor(range, direction);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve(out);
      out.push({ key: cursor.key as K, value: cursor.value as V });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

function threadRange(threadId: string | undefined): IDBKeyRange | null {
  return threadId === undefined ? null : IDBKeyRange.bound([threadId], [threadId, []]);
}

function namespaceRange(threadId: string, ns: string): IDBKeyRange {
  return IDBKeyRange.bound([threadId, ns], [threadId, ns, []]);
}

function checkpointWritesRange(threadId: string, ns: string, checkpointId: string): IDBKeyRange {
  return IDBKeyRange.bound([threadId, ns, checkpointId], [threadId, ns, checkpointId, []]);
}

/**
 * Port of MemorySaver onto IndexedDB. Values are serialized with the same serde
 * so the stored bytes are Uint8Arrays, which IndexedDB keeps natively.
 */
export class IndexedDBSaver extends BaseCheckpointSaver {
  private readonly dbName: string;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(options: { dbName?: string } = {}, serde?: SerializerProtocol) {
    super(serde);
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
  }

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb(this.dbName);
    return this.dbPromise;
  }

  private async loadWrites(threadId: string, ns: string, checkpointId: string): Promise<CheckpointPendingWrite[]> {
    const db = await this.db();
    const rows = await scan<WriteKey, WriteRecord>(db, WRITES, checkpointWritesRange(threadId, ns, checkpointId));
    const ordered = rows
      .map(({ key: [, , , taskId, idx], value }) => ({
        sortKey: writesSortKey(value.taskPath, taskId, idx),
        taskId,
        channel: value.channel,
        bytes: value.value,
      }))
      .sort((a, b) => compareWritesSortKeys(a.sortKey, b.sortKey));
    return Promise.all(
      ordered.map(
        async ({ taskId, channel, bytes }): Promise<CheckpointPendingWrite> =>
          [taskId, channel, await this.serde.loadsTyped("json", bytes)],
      ),
    );
  }

  private async toTuple(
    threadId: string,
    ns: string,
    checkpointId: string,
    record: CheckpointRecord,
    config?: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const tuple: CheckpointTuple = {
      config: config ?? { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpointId } },
      checkpoint: (await this.serde.loadsTyped("json", record.checkpoint)) as Checkpoint,
      metadata: (await this.serde.loadsTyped("json", record.metadata)) as CheckpointMetadata,
      pendingWrites: await this.loadWrites(threadId, ns, checkpointId),
    };
    if (record.parentCheckpointId !== undefined) {
      tuple.parentConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: record.parentCheckpointId },
      };
    }
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = getCheckpointId(config);
    if (threadId === undefined) return undefined;
    const db = await this.db();
    if (checkpointId) {
      const record = await getOne<CheckpointRecord>(db, CHECKPOINTS, [threadId, ns, checkpointId] satisfies CheckpointKey);
      return record && this.toTuple(threadId, ns, checkpointId, record, config);
    }
    const [latest] = await scan<CheckpointKey, CheckpointRecord>(db, CHECKPOINTS, namespaceRange(threadId, ns), "prev", 1);
    return latest && this.toTuple(threadId, ns, latest.key[2], latest.value);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {};
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = config.configurable?.checkpoint_ns as string | undefined;
    const onlyCheckpointId = config.configurable?.checkpoint_id as string | undefined;
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;
    const db = await this.db();
    const rows = await scan<CheckpointKey, CheckpointRecord>(db, CHECKPOINTS, threadRange(threadId), "prev");

    let remaining = limit ?? Infinity;
    for (const {
      key: [rowThread, rowNs, rowId],
      value: record,
    } of rows) {
      if (ns !== undefined && rowNs !== ns) continue;
      if (onlyCheckpointId && rowId !== onlyCheckpointId) continue;
      if (beforeId && rowId >= beforeId) continue;
      const metadata = (await this.serde.loadsTyped("json", record.metadata)) as CheckpointMetadata;
      if (filter && !Object.entries(filter).every(([k, v]) => metadata[k as keyof CheckpointMetadata] === v)) continue;
      if (remaining <= 0) break;
      remaining -= 1;
      yield await this.toTuple(rowThread, rowNs, rowId, record);
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    if (threadId === undefined) {
      throw new Error('Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field.');
    }
    const [[, checkpointBytes], [, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    const record: CheckpointRecord = {
      checkpoint: checkpointBytes,
      metadata: metadataBytes,
      parentCheckpointId: config.configurable?.checkpoint_id as string | undefined,
    };
    const key: CheckpointKey = [threadId, ns, checkpoint.id];
    await transact(await this.db(), CHECKPOINTS, "readwrite", (store) => store.put(record, key));
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (threadId === undefined || checkpointId === undefined) {
      throw new Error("Failed to put writes. The RunnableConfig needs thread_id and checkpoint_id.");
    }
    const serialized = await Promise.all(
      writes.map(async ([channel, value]) => ({ channel, bytes: (await this.serde.dumpsTyped(value))[1] })),
    );
    const db = await this.db();
    const existing = await scan<WriteKey, WriteRecord>(db, WRITES, checkpointWritesRange(threadId, ns, checkpointId));
    const seen = new Set(existing.map((row) => JSON.stringify(row.key)));
    const puts: Array<[WriteKey, WriteRecord]> = [];
    serialized.forEach(({ channel, bytes }, idx) => {
      // Special channels (errors, interrupts) get fixed negative indices so retries overwrite them,
      // while regular writes keep their position and are never overwritten once stored.
      const writeIdx = WRITES_IDX_MAP[channel] || idx;
      const key: WriteKey = [threadId, ns, checkpointId, taskId, writeIdx];
      const id = JSON.stringify(key);
      if (writeIdx >= 0 && seen.has(id)) return;
      seen.add(id);
      puts.push([key, { channel, value: bytes, taskPath: taskPath ?? "" }]);
    });
    await transact(db, WRITES, "readwrite", (store) => {
      for (const [key, record] of puts) store.put(record, key);
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = await this.db();
    const range = IDBKeyRange.bound([threadId], [threadId, []]);
    await Promise.all([
      transact(db, CHECKPOINTS, "readwrite", (store) => store.delete(range)),
      transact(db, WRITES, "readwrite", (store) => store.delete(range)),
    ]);
  }
}
