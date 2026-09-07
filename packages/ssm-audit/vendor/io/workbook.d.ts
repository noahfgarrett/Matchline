/** Types for the `sheetAoaAsync` shim. Off the audit path; see the .js. */
export declare function sheetAoaAsync(
  sheet: unknown,
  onChunk?: (done: number, total: number) => void | Promise<void>,
): Promise<{
  readonly aoa: ReadonlyArray<ReadonlyArray<string>>;
  readonly rowNums: readonly number[];
}>;
