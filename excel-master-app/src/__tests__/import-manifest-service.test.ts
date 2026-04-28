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
        data: { id: "job-123", spreadsheet_id: "sheet-123", status: "succeeded", progress: 100 },
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
            status: "validated",
            result_meta: { worker_status: "imported" },
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
      progress: {
        percent: 100,
        total_items: 1,
        completed_items: 1,
        failed_items: 0,
        pending_items: 0,
      },
    });
    expect(client.queries.map((query) => query.table)).toEqual([
      "jobs",
      "external_import_manifests",
      "external_import_manifest_items",
    ]);
    expect(client.queries[0].query.operations).toEqual(
      expect.arrayContaining([
        { name: "select", args: [expect.not.stringContaining("payload")] },
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

  it("returns a queued job without requiring a manifest yet", async () => {
    const client = new FakeSupabaseClient({
      jobs: {
        data: {
          id: "job-queued-123",
          spreadsheet_id: "sheet-123",
          status: "queued",
          progress: 0,
          result_meta: { parsed_table_count: 3 },
        },
        error: null,
      },
      external_import_manifests: {
        data: null,
        error: null,
      },
    });

    const status = await getExternalImportStatus(
      { spreadsheetId: "sheet-123", jobId: "job-queued-123" },
      client as never,
    );

    expect(status).toMatchObject({
      spreadsheet_id: "sheet-123",
      job_id: "job-queued-123",
      status: "queued",
      manifest: null,
      manifest_items: [],
      progress: {
        percent: 0,
        total_items: 3,
        completed_items: 0,
        failed_items: 0,
        pending_items: 3,
      },
    });
    expect(client.queries.map((query) => query.table)).toEqual(["jobs", "external_import_manifests"]);
  });

  it("surfaces chunk progress and has_next_step from job result metadata", async () => {
    const client = new FakeSupabaseClient({
      jobs: {
        data: {
          id: "job-running-123",
          spreadsheet_id: "sheet-123",
          status: "running",
          progress: 45,
          result_meta: {
            current_step: "write_chunk",
            current_table: "payable",
            completed_chunks: 2,
            total_chunks: 5,
            rows_written: 100,
            cursor: { chunk_index: 0, row_offset: 100 },
          },
        },
        error: null,
      },
      external_import_manifests: {
        data: { id: "manifest-123", job_id: "job-running-123", spreadsheet_id: "sheet-123", status: "imported" },
        error: null,
      },
      external_import_manifest_items: {
        data: [
          { id: "item-1", manifest_id: "manifest-123", status: "imported", result_meta: {} },
          { id: "item-2", manifest_id: "manifest-123", status: "parsed", result_meta: {} },
          { id: "item-3", manifest_id: "manifest-123", status: "failed", result_meta: {} },
        ],
        error: null,
      },
    });

    const status = await getExternalImportStatus(
      { spreadsheetId: "sheet-123", jobId: "job-running-123" },
      client as never,
    );

    expect(status).toMatchObject({
      status: "running",
      has_next_step: true,
      current_step: "write_chunk",
      current_table: "payable",
      completed_chunks: 2,
      total_chunks: 5,
      rows_written: 100,
      progress: {
        percent: 45,
        total_items: 3,
        completed_items: 1,
        failed_items: 1,
        pending_items: 1,
      },
    });
  });
});
