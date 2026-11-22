/** Durable history supplies order; exact execution identities protect unfinished overlays. */
export function mergeExecutionHistory<
  T extends { readonly id?: string | undefined; readonly turnId?: string | undefined },
>(
  durable: readonly T[],
  current: readonly T[],
  overlays: readonly { readonly turnId: string; readonly userMessageId: string }[],
): readonly T[] {
  const matches = (
    entry: T,
    execution: { readonly turnId: string; readonly userMessageId: string },
  ): boolean => entry.turnId === execution.turnId || entry.id === execution.userMessageId;
  const replacements = overlays.map((execution) =>
    current.filter((entry) => matches(entry, execution)),
  );
  const inserted = new Set<number>();
  const merged: T[] = [];
  for (const entry of durable) {
    const index = overlays.findIndex(
      (execution, index) => matches(entry, execution) && replacements[index]!.length > 0,
    );
    if (index === -1) merged.push(entry);
    else if (!inserted.has(index)) {
      merged.push(...replacements[index]!);
      inserted.add(index);
    }
  }
  for (const [index, replacement] of replacements.entries())
    if (!inserted.has(index)) merged.push(...replacement);
  return merged;
}
