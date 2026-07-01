import { vi, describe, it, expect, beforeEach } from 'vitest';

type DevRow = { id: number };

type RpcResponse<T> = { data: T[] | null; error: unknown | null };

type MockSb = {
  from: (_table: string) => {
    select: () => {
      eq: (col: string, val?: unknown) => {
        limit: (n?: number) => { data: DevRow[] };
      };
    };
  };
  rpc: ReturnType<typeof vi.fn>;
  auth: { getUser: ReturnType<typeof vi.fn> };
};

// Create a stable mock Supabase admin object shared by route and test
const mockSb = {
  from: vi.fn().mockImplementation(() => ({
    select: () => ({ eq: () => ({ limit: () => ({ data: [] as DevRow[] }) }) }),
  })),
  rpc: vi.fn() as unknown as ReturnType<typeof vi.fn>,
  auth: { getUser: vi.fn() } as { getUser: ReturnType<typeof vi.fn> },
} as unknown as MockSb;

vi.mock('@/lib/supabase', async () => {
  const actual = await vi.importActual('@/lib/supabase');
  return {
    ...(actual as object),
    getSupabaseAdmin: () => mockSb,
  };
});

describe('arcade game route', () => {
  let _prevSecret: string | undefined;
  beforeEach(() => {
    // preserve env
    _prevSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret';
    vi.resetAllMocks();
    // default auth user
    (mockSb.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { user: { id: 'user-1', user_metadata: {} } }, error: null });
  });

  afterEach(() => {
    // restore env
    if (_prevSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = _prevSecret;
  });

  it('processes concurrent submits with one winning RPC', async () => {
    // Mock developer lookup returning id. Support chain .select(...).eq(...).limit(...)
    (mockSb.from as ReturnType<typeof vi.fn>).mockImplementation((_table: string) => {
      return {
        select: () => ({
          eq: () => ({
            limit: () => ({ data: _table === 'developers' ? [{ id: 123 }] : [] as DevRow[] }),
          }),
        }),
      } as unknown as ReturnType<typeof vi.fn>;
    });

    // Simulate RPC: first call returns success, second call returns subsequent response
    let calls = 0;
    (mockSb.rpc as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ data: [{ best_ms: 50, attempts: 1, is_new_record: true, rank: 5, milestones: ['first_try'], px_earned: 5 }], error: null } as RpcResponse<Record<string, unknown>>);
      }
      return Promise.resolve({ data: [{ best_ms: 50, attempts: 2, is_new_record: false, rank: 6, milestones: [], px_earned: 0 }], error: null } as RpcResponse<Record<string, unknown>>);
    });

    const { POST } = await import('./route');

    // Create two fake requests
    const startTime = Date.now() - 10000;
    // compute signature matching server's HMAC with fallback-secret
    const crypto = await import('crypto');
    const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fallback-secret';
    const signature = crypto.createHmac('sha256', SECRET).update(`user-1:10s_classic:${startTime}`).digest('hex');
    const reqBody = {
      action: 'stop',
      game: '10s_classic',
      game_token: { startTime, signature },
    };

    type FakeReq = { json: () => Promise<Record<string, unknown>>; headers: { get: (name: string) => string | null } };
    const makeReq = (token: string): FakeReq => ({
      json: async () => reqBody,
      headers: { get: () => `Bearer ${token}` },
    });

    const p1 = POST(makeReq('t1'));
    const p2 = POST(makeReq('t2'));

    const r1 = await p1;
    const r2 = await p2;

    expect((mockSb.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // Both calls should succeed at HTTP level
    const json1 = await r1.json();
    const json2 = await r2.json();
    expect(json1.ok).toBe(true);
    expect(json2.ok).toBe(true);
    // At least one call must report milestones or px earned
    const anyPx = (json1.result?.px_earned ?? 0) + (json2.result?.px_earned ?? 0);
    expect(anyPx).toBeGreaterThanOrEqual(5);
  });
});
