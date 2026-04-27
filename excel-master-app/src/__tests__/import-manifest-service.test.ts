import { getExternalImportStatus } from "@/lib/external-import/import-manifest-service";

interface FakeResult<T> {
  data: T | null;
  error: unknown;
}

class FakeQueryBuilder<T> implements PromiseLike<FakeResult<T>> {
  readonly operations: Array<{ name: string; args: unknown[] }> = [];

  constructor(private readonly result: FakeResult<T>) {}

  select(columns?: string) {
    this.operations.push({ name: "select", args: [columns] });
    return this;
  }

  eq(column: string, value: string) {
    this.operations.push({ name: "eq", args: [column, value] });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.operations.push({ name: "order", args: [column, options] });
    return this;
  }

  limit(count: number) {
    this.operations.push({ name: "limit", args: [count] });
    return this;
  }

  async maybeSingle() {
    this.operations.push({ name: "maybeSingle", args: [] });
    return this.result;
  }

  then<TResult1 = FakeResult<T>, TResult2 = never>(
    onfulfilled?: ((value: FakeResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

class FakeSupabaseClient {
  readonly queries: Array<{ table: string; query: FakeQueryBuilder<unknown> }> = [];

  constructor(private readonly resultsByTable: Record<string, FakeResult<unknown>>) {}

  from(table: string) {
    const query = new FakeQueryBuilder(this.resultsByTable[table] ?? { data: null, error: null });
    this.queries.push({ table, query });
    return query;
  }
}

describe("external import manifest service", () => {
  it("reads durable job, manifest, and item status from Supabase tables", async () => {
    const client = new FakeSupabaseClient({
      jobs: {
        data: { id: "job-123", spreadsheet_id: "sheet-123", status: "succeeded" },
        error: null,
      },
      external_import_manifests: {
        data: { id: "manifest-123", job_id: "job-123", spreadsheet_id: "sheet-123", status: "parsed" },
        error: null,
      },
      external_import_manifest_items: {
        data: [
          {
            id: "item-123",
            manifest_id: "manifest-123",
            job_id: "job-123",
            spreadsheet_id: "sheet-123",
            source_table: "payable",
            status: "parsed",
          },
        ],
        error: null,
      },
    });

    const status = await getExternalImportStatus(
      { spreadsheetId: "sheet-123", jobId: "job-123" },
      client as never,
    );

    expect(status).toMatchObject({
      spreadsheet_id: "sheet-123",
      job_id: "job-123",
      status: "succeeded",
      manifest_items: [{ id: "item-123", source_table: "payable" }],
    });
    expect(client.queries.map((query) => query.table)).toEqual([
      "jobs",
      "external_import_manifests",
      "external_import_manifest_items",
    ]);
    expect(client.queries[0].query.operations).toEqual(
      expect.arrayContaining([
        { name: "eq", args: ["spreadsheet_id", "sheet-123"] },
        { name: "eq", args: ["job_type", "external_import"] },
        { name: "eq", args: ["id", "job-123"] },
        { name: "order", args: ["created_at", { ascending: false }] },
        { name: "limit", args: [1] },
        { name: "maybeSingle", args: [] },
      ]),
    );
    expect(client.queries[2].query.operations).toEqual(
      expect.arrayContaining([
        { name: "eq", args: ["manifest_id", "manifest-123"] },
        { name: "order", args: ["created_at", { ascending: true }] },
      ]),
    );
  });
});
