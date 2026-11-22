# Review checklist

Choose the checks that match the change. A checklist item becomes a finding only
when the code and a concrete trigger support it.

- Follow external input from validation to use, including nested structures and
  normalization. Check ownership and immutable identity at asynchronous boundaries.
- Read both sides of changed contracts: producer, consumer, persisted records and
  UI mirrors. Check compatibility with records and callers from previous versions.
- Exercise error, cancellation and retry paths. Confirm accepted work settles
  before disposal or a durable terminal event closes its scope.
- Distinguish user decisions, durable facts and cached display state. Confirm a
  stale UI response cannot authorize or display another Session's operation.
- Inspect tests for observable behavior. A passing mock that omits the real shape
  does not prove compatibility with the producer.
- Keep the severity proportional to the demonstrated user impact. Avoid style
  preferences, unrelated preexisting behavior and unsupported security claims.
