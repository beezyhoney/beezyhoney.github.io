// In-memory stand-ins for Workers KV and the Cache API, with operation counters (KV free-plan budgets).
import type { CacheLike, KVLike } from '../../src/server/media';

type Stored = { value: Uint8Array; metadata: unknown };
type GetType = 'text' | 'json' | 'arrayBuffer' | 'stream';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class FakeKV implements KVLike {
  readonly data = new Map<string, Stored>();
  readonly ops = { reads: 0, writes: 0, deletes: 0, lists: 0 };

  private type(o?: { type?: GetType } | GetType): GetType {
    return typeof o === 'string' ? o : o?.type ?? 'text';
  }

  private decode(v: Uint8Array, type: GetType): unknown {
    if (type === 'arrayBuffer') return v.slice().buffer;
    if (type === 'json') return JSON.parse(dec.decode(v));
    if (type === 'stream') return new Blob([v]).stream();
    return dec.decode(v);
  }

  async get(key: string, o?: { type?: GetType } | GetType): Promise<unknown> {
    this.ops.reads++;
    const s = this.data.get(key);
    return s ? this.decode(s.value, this.type(o)) : null;
  }

  async getWithMetadata<M = unknown>(key: string, o?: { type?: GetType } | GetType): Promise<{ value: unknown; metadata: M | null }> {
    this.ops.reads++;
    const s = this.data.get(key);
    return s ? { value: this.decode(s.value, this.type(o)), metadata: (s.metadata ?? null) as M | null } : { value: null, metadata: null };
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, o?: { metadata?: unknown }): Promise<void> {
    this.ops.writes++;
    if (!key || key.length > 512) throw new Error('KV: bad key');
    if (o?.metadata !== undefined && JSON.stringify(o.metadata).length > 1024) throw new Error('KV: metadata over 1024 bytes');
    let bytes: Uint8Array;
    if (typeof value === 'string') bytes = enc.encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    else throw new Error('KV fake: streams not supported');
    if (bytes.length > 25 * 1024 * 1024) throw new Error('KV: value over 25 MiB');
    this.data.set(key, { value: bytes, metadata: o?.metadata });
  }

  async delete(key: string): Promise<void> {
    this.ops.deletes++;
    this.data.delete(key);
  }

  async list(o: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }> {
    this.ops.lists++;
    const limit = Math.min(o.limit ?? 1000, 1000);
    const all = [...this.data.keys()].filter((k) => k.startsWith(o.prefix ?? '')).sort();
    const start = o.cursor ? Number(o.cursor) : 0;
    const page = all.slice(start, start + limit);
    const done = start + limit >= all.length;
    return { keys: page.map((name) => ({ name, metadata: this.data.get(name)!.metadata })), list_complete: done, ...(done ? {} : { cursor: String(start + limit) }) };
  }
}

export class FakeCache implements CacheLike {
  readonly store = new Map<string, Response>();
  hits = 0;
  async match(req: Request | string): Promise<Response | undefined> {
    const r = this.store.get(typeof req === 'string' ? req : req.url);
    if (r) this.hits++;
    return r?.clone();
  }
  async put(req: Request | string, res: Response): Promise<void> {
    this.store.set(typeof req === 'string' ? req : req.url, res.clone());
  }
}

/** Collects waitUntil promises so a test can await them */
export class FakeCtx {
  readonly pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>): void { this.pending.push(p); }
  async settle(): Promise<void> { await Promise.all(this.pending); }
}
