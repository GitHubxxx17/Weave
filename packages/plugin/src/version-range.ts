/**
 * A deliberately small subset of semver ranges, used for `engines.weave`.
 *
 * Versions are always a full numeric `x.y.z`; there are no pre-release tags,
 * matching the manifest's own `version`. A range is one or more
 * space-separated comparators that must all hold:
 *
 * - `*` or `x`: any version;
 * - `1.x` or `1.2.x` (`X` and `*` also work): one major or minor line;
 * - `x.y.z` with an optional `=`, `>`, `>=`, `<`, `<=`, `^` or `~` prefix.
 *
 * Anything else (`||`, hyphen ranges, partial versions such as `>=1.2`) is
 * rejected instead of being guessed at, so a range never silently means
 * something other than what its author wrote.
 */

type Triple = readonly [number, number, number];
type Predicate = (version: Triple) => boolean;

/** A parsed range that can be tested against concrete versions. */
export interface VersionRange {
  /** Whether `version` (a full `x.y.z`) satisfies every comparator of the range. */
  test(version: string): boolean;
}

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const anyPattern = /^[xX*]$/;
const majorLinePattern = /^(\d+)\.[xX*]$/;
const minorLinePattern = /^(\d+)\.(\d+)\.[xX*]$/;
const comparatorPattern = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/;

function integer(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Parses a full numeric `x.y.z`; returns `undefined` for anything else. */
export function parseVersion(text: string): Triple | undefined {
  const match = versionPattern.exec(text);
  const major = integer(match?.[1]);
  const minor = integer(match?.[2]);
  const patch = integer(match?.[3]);
  return major === undefined || minor === undefined || patch === undefined
    ? undefined
    : [major, minor, patch];
}

function compare(left: Triple, right: Triple): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** The exclusive upper bound of `^base`: the leftmost non-zero part may not change. */
function caretUpperBound([major, minor, patch]: Triple): Triple {
  if (major > 0) {
    return [major + 1, 0, 0];
  }
  if (minor > 0) {
    return [0, minor + 1, 0];
  }
  return [0, 0, patch + 1];
}

function parseComparator(token: string): Predicate {
  if (anyPattern.test(token)) {
    return () => true;
  }

  const majorLine = majorLinePattern.exec(token);
  if (majorLine !== null) {
    const major = integer(majorLine[1]);
    if (major !== undefined) {
      return (version) => version[0] === major;
    }
  }

  const minorLine = minorLinePattern.exec(token);
  if (minorLine !== null) {
    const major = integer(minorLine[1]);
    const minor = integer(minorLine[2]);
    if (major !== undefined && minor !== undefined) {
      return (version) => version[0] === major && version[1] === minor;
    }
  }

  const comparator = comparatorPattern.exec(token);
  const base = parseVersion(comparator?.[2] ?? '');
  if (comparator !== null && base !== undefined) {
    switch (comparator[1] ?? '=') {
      case '>':
        return (version) => compare(version, base) > 0;
      case '>=':
        return (version) => compare(version, base) >= 0;
      case '<':
        return (version) => compare(version, base) < 0;
      case '<=':
        return (version) => compare(version, base) <= 0;
      case '~': {
        const upper: Triple = [base[0], base[1] + 1, 0];
        return (version) => compare(version, base) >= 0 && compare(version, upper) < 0;
      }
      case '^': {
        const upper = caretUpperBound(base);
        return (version) => compare(version, base) >= 0 && compare(version, upper) < 0;
      }
      default:
        return (version) => compare(version, base) === 0;
    }
  }

  throw new RangeError(
    `Unsupported version comparator "${token}"; use *, 1.x, 1.2.x or an optional ` +
      `=, >, >=, <, <=, ^, ~ prefix on a full x.y.z version`,
  );
}

/**
 * Parses a version range. Throws a `RangeError` when the range is empty or
 * uses syntax outside the supported subset.
 */
export function parseVersionRange(text: string): VersionRange {
  if (text.trim() === '') {
    throw new RangeError('A version range must not be empty');
  }
  const predicates = text.trim().split(/\s+/).map(parseComparator);
  return {
    test(version) {
      const parsed = parseVersion(version);
      if (parsed === undefined) {
        throw new RangeError(`"${version}" is not a full x.y.z version`);
      }
      return predicates.every((predicate) => predicate(parsed));
    },
  };
}

/** Whether `text` is a range {@link parseVersionRange} accepts. */
export function isValidVersionRange(text: string): boolean {
  try {
    parseVersionRange(text);
    return true;
  } catch {
    return false;
  }
}
