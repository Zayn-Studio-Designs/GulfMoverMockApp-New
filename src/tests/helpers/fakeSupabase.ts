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

  reset() {
    this.session = { user: { id: 'auth-user-1' } };
    this.tables = {
      profiles: ok(null),
      organization_memberships: ok([]),
      role_assignments: ok([]),
    };
    this.queries = [];
    this.writeAttempts = [];
    this.rpc.mockReset();
    this.rpc.mockImplementation(() => ({ data: null, error: { message: 'no rpc handler configured', code: 'TEST' }, status: 500 }));
    client.auth.getSession.mockClear();
    client.from.mockClear();
    client.rpc.mockClear();
  },

  /** Convenience: memberships as PostgREST returns them, with embedded organisation (or null when RLS hides it). */
  setMemberships(rows: Array<{ orgId: string; role?: string; status?: string; org: null | { legalName: string; displayName?: string | null; status: string } }>) {
    this.tables.organization_memberships = ok(rows.map(r => ({
      organization_id: r.orgId,
      membership_role: r.role ?? 'company_admin',
      status: r.status ?? 'active',
      organizations: r.org === null ? null : { id: r.orgId, legal_name: r.org.legalName, display_name: r.org.displayName ?? null, status: r.org.status },
    })));
  },
};

function builder(table: string) {
  const recorded: RecordedQuery = { table, filters: [] };
  fake.queries.push(recorded);
  const respond = () => Promise.resolve(fake.tables[table] ?? ok(null));
  const forbidden = (method: string) => () => {
    fake.writeAttempts.push(`${table}.${method}`);
    throw new Error(`Direct ${method} on ${table} is not allowed from the client`);
  };
  const b = {
    select(columns: string) { recorded.select = columns; return b; },
    eq(column: string, value: unknown) { recorded.filters.push(['eq', column, value]); return b; },
    is(column: string, value: unknown) { recorded.filters.push(['is', column, value]); return b; },
    maybeSingle() { return respond(); },
    insert: forbidden('insert'),
    update: forbidden('update'),
    upsert: forbidden('upsert'),
    delete: forbidden('delete'),
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
  rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => fake.rpc(fn, args)),
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
