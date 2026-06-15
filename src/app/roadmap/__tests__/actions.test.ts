import { describe, it, expect, vi } from "vitest";

// We'll import the module under test after mocking its dependencies

// Mock createServerSupabase to return an auth object with a user
vi.mock("@/lib/supabase-server", () => ({
  createServerSupabase: vi.fn(() => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", user_metadata: { user_name: "testuser" } } } }),
    },
  })),
}));

// We'll provide a mock getSupabaseAdmin that lets us observe calls
const upsertSpy = vi.fn(async () => ({ error: null }));
const insertSpy = vi.fn(async () => ({ error: null }));
const deleteSpy = vi.fn(async () => ({ error: null }));

// Create a single admin object so tests can mutate its returned "from" instance
// Shared roadmap_votes from-object so tests can mutate its __existing field
const roadmapFromObj: any = {
  select: () => ({
    eq: function () {
      return this;
    },
    maybeSingle: async function () {
      return (roadmapFromObj as any).__existing ?? { data: null };
    },
  }),
  delete: () => ({ eq: (col: string, val: any) => { deleteSpy(col, val); return { error: null }; } }),
  insert: (row: any) => { insertSpy(row); return { error: null }; },
  upsert: (row: any, opts: any) => { upsertSpy(row, opts); return { error: null }; },
};

const adminObj: any = {
  from(table: string) {
    if (table === "developers") {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { id: 42 } }) }) }),
      };
    }
    if (table === "roadmap_votes") {
      return roadmapFromObj;
    }
    return { select: () => ({ maybeSingle: async () => ({ data: null }) }) };
  }
};

vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(() => adminObj),
}));

// Mock roadmap-data so the server action's VOTABLE_ITEM_IDS check passes
vi.mock("@/lib/roadmap-data", () => ({
  VOTABLE_ITEM_IDS: new Set(["feature_x"]),
}));

// Mock next/cache revalidation helper used in the action
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Import the function under test after mocks applied
import { toggleVote } from "../actions";

describe("toggleVote idempotency behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a vote when none exists (calls upsert)", async () => {
    // Ensure roadmap_votes select.maybeSingle returns no existing vote
    const admin = (await import("@/lib/supabase")).getSupabaseAdmin();
    const fromObj = admin.from("roadmap_votes");
    (fromObj as any).__existing = { data: null };

    await toggleVote("feature_x");

    expect(upsertSpy).toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("removes vote when existing row present (calls delete)", async () => {
    const admin = (await import("@/lib/supabase")).getSupabaseAdmin();
    const fromObj = admin.from("roadmap_votes");
    (fromObj as any).__existing = { data: { id: 99 } };

    await toggleVote("feature_x");

    expect(deleteSpy).toHaveBeenCalled();
    // If available, verify the second arg was the expected id
    if ((deleteSpy as any).mock?.calls?.[0]) {
      expect((deleteSpy as any).mock.calls[0][1]).toBe(99);
    }
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  // Note: database-level idempotency is enforced by Postgres unique constraint
  // and the use of `upsert(...)` in the production code. The first test above
  // already asserts that `upsert` is used and `insert` is not. A concurrency
  // simulation here would be superficial because the Supabase client is
  // mocked; keeping tests small and focused avoids brittle behavior.
});
