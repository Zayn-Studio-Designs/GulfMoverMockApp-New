import { vi } from 'vitest';

/**
 * In-memory stand-in for the Supabase client used by `src/lib/companyService.ts`.
 * Nothing here touches the network: tests wire it in with
 *   vi.mock('@supabase/supabase-js', async () => (await import('./helpers/fakeSupabase')).fakeSupabaseModule)
 * and drive responses per table / per RPC call. Every query is recorded so tests can
 * assert filters, and every WRITE builder method throws — proving the client never
 * writes protected tables directly.
 */

export interface FakeResponse {
  data: unknown;
  error: { message?: string; code?: string } | null;
  status?: number;
}

export interface RecordedQuery {
  table: string;
  select?: string;
  filters: Array<[string, string, unknown]>;
}

type RpcHandler = (fn: string, args: Record<string, unknown>) => Promise<FakeResponse> | FakeResponse;

const ok = (data: unknown): FakeResponse => ({ data, error: null, status: 200 });

export const fake = {
  session: null as { user: { id: string } } | null,
  tables: {} as Record<string, FakeResponse>,
  queries: [] as RecordedQuery[],
  rpc: vi.fn<RpcHandler>(),
  writeAttempts: [] as string[],
  /** Tables a test explicitly allows direct writes to (ATCO operations tables only). */
  writableTables: new Set<string>(),
  /** Allowed writes, recorded: [table, method, payload]. */
  writes: [] as Array<[string, string, unknown]>,

  reset() {
    this.session = { user: { id: 'auth-user-1' } };
    this.tables = {
      profiles: ok(null),
      role_assignments: ok([]),
      // Read-only RPC served from here so `fake.rpc` only ever records write/business calls.
      'rpc:my_company_memberships': ok([]),
    };
    this.queries = [];
    this.writeAttempts = [];
    this.writableTables = new Set();
    this.writes = [];
    this.rpc.mockReset();
    this.rpc.mockImplementation(() => ({ data: null, error: { message: 'no rpc handler configured', code: 'TEST' }, status: 500 }));
    client.auth.getSession.mockClear();
    client.from.mockClear();
    client.rpc.mockClear();
  },

  /** Convenience: rows exactly as my_company_memberships() returns them. */
  setMemberships(rows: Array<{ orgId: string; role?: string; status?: string; org: { legalName: string; displayName?: string | null; status: string } }>) {
    this.tables['rpc:my_company_memberships'] = ok(rows.map(r => ({
      organization_id: r.orgId,
      legal_name: r.org.legalName,
      display_name: r.org.displayName ?? null,
      organization_status: r.org.status,
      membership_role: r.role ?? 'company_admin',
      membership_status: r.status ?? 'active',
    })));
  },
};

function builder(table: string) {
  const recorded: RecordedQuery = { table, filters: [] };
  fake.queries.push(recorded);
  const respond = () => Promise.resolve(fake.tables[table] ?? ok(null));
  const write = (method: string) => (payload?: unknown) => {
    if (!fake.writableTables.has(table)) {
      fake.writeAttempts.push(`${table}.${method}`);
      throw new Error(`Direct ${method} on ${table} is not allowed from the client`);
    }
    fake.writes.push([table, method, payload]);
    return b;
  };
  const filter = (op: string) => (column: string, value: unknown) => { recorded.filters.push([op, column, value]); return b; };
  const b = {
    select(columns: string) { recorded.select = columns; return b; },
    eq: filter('eq'), is: filter('is'), gt: filter('gt'), gte: filter('gte'), lte: filter('lte'), in: filter('in'), ilike: filter('ilike'),
    order: filter('order'), limit: (n: number) => { recorded.filters.push(['limit', '', n]); return b; },
    range: (from: number, to: number) => { recorded.filters.push(['range', String(from), to]); return b; },
    maybeSingle() { return respond(); },
    single() { return respond(); },
    insert: write('insert'),
    update: write('update'),
    upsert: write('upsert'),
    delete: write('delete'),
    then<T1, T2>(onFulfilled?: (value: FakeResponse) => T1, onRejected?: (reason: unknown) => T2) {
      return respond().then(onFulfilled, onRejected);
    },
  };
  return b;
}

const client = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: fake.session }, error: null })),
  },
  from: vi.fn((table: string) => builder(table)),
  rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    const served = fake.tables[`rpc:${fn}`];
    return served ?? fake.rpc(fn, args);
  }),
};

export const fakeClient = client;

export const fakeSupabaseModule = {
  createClient: vi.fn(() => client),
};

/** A promise whose settlement the test controls (for in-flight / race scenarios). */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
