/**
 * Operator-controlled gate for merging pull requests.
 *
 * A merge writes to a shared branch and cannot be undone through the API, so it is
 * disabled by default: `bitbucket_mergePullRequest` is not even registered unless the
 * operator enables it and names the repositories it may merge in. The allowed scope is
 * read from the environment once at startup, so the model can never select or widen it.
 * Read-only mergeability checks are not gated.
 */
export interface MergeGateway {
  /** Whether merging is enabled and at least one valid repository pattern resolved. */
  enabled: boolean;
  /** Allowed `PROJECT/repository-slug` targets; a `PROJECT/*` entry allows the whole project. */
  repos: string[];
  /** Allowed target refs; a trailing `*` matches a prefix. Empty means any ref in an allowed repository. */
  targetRefs: string[];
}

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

const DISABLED: MergeGateway = { enabled: false, repos: [], targetRefs: [] };

const REPO_ENTRY_RE = /^[^\s/]+\/[^\s/]+$/;

function readBool(env: Env, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '').split(/[,;\s]+/).map(entry => entry.trim()).filter(Boolean);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Accepts `PROJECT/repository-slug` or `PROJECT/*`. The project key is upper-cased and
 * the slug lower-cased to match the casing the REST API uses, so comparisons are exact.
 */
function normalizeRepoEntry(entry: string, warn: Warn): string | undefined {
  if (!REPO_ENTRY_RE.test(entry)) {
    warn(`Ignoring merge repository entry that is not "PROJECT/repository-slug" or "PROJECT/*": "${entry}"`);
    return undefined;
  }
  const [projectKey, slug] = entry.split('/');
  if (projectKey === '*') {
    warn(`Ignoring merge repository entry that would allow every project: "${entry}"`);
    return undefined;
  }
  return `${projectKey.toUpperCase()}/${slug.toLowerCase()}`;
}

/** Bare branch names are expanded so operators can write `develop` instead of `refs/heads/develop`. */
function normalizeRefEntry(entry: string): string {
  return entry.startsWith('refs/') ? entry : `refs/heads/${entry}`;
}

function matchesPattern(value: string, pattern: string): boolean {
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

/**
 * Reads the merge gateway configuration from the environment. Merging only activates
 * when the flag is set and at least one repository entry is valid; otherwise a warning
 * is logged and the gateway stays disabled.
 */
export function resolveMergeGateway(options?: { env?: Env; warn?: Warn }): MergeGateway {
  const env = options?.env ?? process.env;
  const warn = options?.warn ?? ((message: string) => console.error(`[merge-gateway] ${message}`));

  if (!readBool(env, 'BITBUCKET_MERGE_ENABLED')) {
    return DISABLED;
  }

  const repos = dedupe(
    parseList(env.BITBUCKET_MERGE_ALLOWED_REPOS)
      .map(entry => normalizeRepoEntry(entry, warn))
      .filter((entry): entry is string => Boolean(entry)),
  );

  if (repos.length === 0) {
    warn(
      'Merging was enabled but no valid repository is configured (set BITBUCKET_MERGE_ALLOWED_REPOS ' +
        'to a list of "PROJECT/repository-slug" or "PROJECT/*" entries); the merge tool will stay disabled.',
    );
    return DISABLED;
  }

  return {
    enabled: true,
    repos,
    targetRefs: dedupe(parseList(env.BITBUCKET_MERGE_ALLOWED_TARGET_REFS).map(normalizeRefEntry)),
  };
}

/** Throws unless the gateway allows merging in this repository. No network call. */
export function assertRepoMergeAllowed(gateway: MergeGateway, projectKey: string, repositorySlug: string): void {
  if (!gateway.enabled) {
    throw new Error(
      'Merging pull requests is disabled on this server. Enable it with BITBUCKET_MERGE_ENABLED ' +
        'and list the allowed repositories in BITBUCKET_MERGE_ALLOWED_REPOS.',
    );
  }
  const target = `${projectKey.toUpperCase()}/${repositorySlug.toLowerCase()}`;
  if (!gateway.repos.some(pattern => matchesPattern(target, pattern))) {
    throw new Error(
      `Merging is not allowed in ${target} on this server. Allowed: ${gateway.repos.join(', ')}.`,
    );
  }
}

/** Throws unless the gateway allows merging into this target ref. A gateway with no ref restriction allows all. */
export function assertTargetRefMergeAllowed(gateway: MergeGateway, targetRefId: string | undefined): void {
  if (gateway.targetRefs.length === 0) {
    return;
  }
  if (!targetRefId) {
    throw new Error(
      'Could not determine the target branch of the pull request, and this server restricts which ' +
        'branches may be merged into (BITBUCKET_MERGE_ALLOWED_TARGET_REFS); refusing to merge.',
    );
  }
  if (!gateway.targetRefs.some(pattern => matchesPattern(targetRefId, pattern))) {
    throw new Error(
      `Merging into ${targetRefId} is not allowed on this server. ` +
        `Allowed target refs: ${gateway.targetRefs.join(', ')}.`,
    );
  }
}
