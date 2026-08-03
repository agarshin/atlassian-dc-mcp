import {
  assertRepoMergeAllowed,
  assertTargetRefMergeAllowed,
  resolveMergeGateway,
} from '../merge-gateway.js';

const silentWarn = () => undefined;

describe('resolveMergeGateway', () => {
  it('is disabled by default', () => {
    const gateway = resolveMergeGateway({ env: {}, warn: silentWarn });
    expect(gateway.enabled).toBe(false);
    expect(gateway.repos).toEqual([]);
  });

  it('stays disabled when enabled without any repository', () => {
    const gateway = resolveMergeGateway({ env: { BITBUCKET_MERGE_ENABLED: 'true' }, warn: silentWarn });
    expect(gateway.enabled).toBe(false);
  });

  it('stays disabled when every configured repository entry is malformed', () => {
    const gateway = resolveMergeGateway({
      env: { BITBUCKET_MERGE_ENABLED: 'true', BITBUCKET_MERGE_ALLOWED_REPOS: 'demo, PROJ/a/b, */*' },
      warn: silentWarn,
    });
    expect(gateway.enabled).toBe(false);
  });

  it('normalizes repository entries and de-duplicates them', () => {
    const gateway = resolveMergeGateway({
      env: {
        BITBUCKET_MERGE_ENABLED: 'yes',
        BITBUCKET_MERGE_ALLOWED_REPOS: 'proj/Demo, PROJ/demo; OTHER/*',
      },
      warn: silentWarn,
    });
    expect(gateway.enabled).toBe(true);
    expect(gateway.repos).toEqual(['PROJ/demo', 'OTHER/*']);
    expect(gateway.targetRefs).toEqual([]);
  });

  it('expands bare branch names into fully-qualified target refs', () => {
    const gateway = resolveMergeGateway({
      env: {
        BITBUCKET_MERGE_ENABLED: '1',
        BITBUCKET_MERGE_ALLOWED_REPOS: 'PROJ/demo',
        BITBUCKET_MERGE_ALLOWED_TARGET_REFS: 'develop, refs/heads/release/*',
      },
      warn: silentWarn,
    });
    expect(gateway.targetRefs).toEqual(['refs/heads/develop', 'refs/heads/release/*']);
  });

  it('warns about ignored entries and about being enabled with no valid repository', () => {
    const warnings: string[] = [];
    resolveMergeGateway({
      env: { BITBUCKET_MERGE_ENABLED: 'true', BITBUCKET_MERGE_ALLOWED_REPOS: 'demo' },
      warn: message => warnings.push(message),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"demo"');
    expect(warnings[1]).toContain('stay disabled');
  });
});

describe('assertRepoMergeAllowed', () => {
  const gateway = resolveMergeGateway({
    env: { BITBUCKET_MERGE_ENABLED: 'true', BITBUCKET_MERGE_ALLOWED_REPOS: 'PROJ/demo, OTHER/*' },
    warn: silentWarn,
  });

  it('refuses everything when merging is disabled', () => {
    expect(() => assertRepoMergeAllowed({ enabled: false, repos: [], targetRefs: [] }, 'PROJ', 'demo'))
      .toThrow(/disabled on this server/);
  });

  it('allows an exact repository regardless of the casing used by the caller', () => {
    expect(() => assertRepoMergeAllowed(gateway, 'proj', 'DEMO')).not.toThrow();
  });

  it('allows any repository in a wildcard project', () => {
    expect(() => assertRepoMergeAllowed(gateway, 'OTHER', 'anything')).not.toThrow();
  });

  it('refuses a repository outside the allowed list', () => {
    expect(() => assertRepoMergeAllowed(gateway, 'PROJ', 'other-repo')).toThrow(/not allowed in PROJ\/other-repo/);
  });

  it('does not treat a wildcard project as a prefix of another project', () => {
    expect(() => assertRepoMergeAllowed(gateway, 'OTHERS', 'demo')).toThrow(/not allowed/);
  });
});

describe('assertTargetRefMergeAllowed', () => {
  const unrestricted = { enabled: true, repos: ['PROJ/demo'], targetRefs: [] };
  const restricted = {
    enabled: true,
    repos: ['PROJ/demo'],
    targetRefs: ['refs/heads/develop', 'refs/heads/release/*'],
  };

  it('allows any ref when no target-ref restriction is configured', () => {
    expect(() => assertTargetRefMergeAllowed(unrestricted, 'refs/heads/master')).not.toThrow();
    expect(() => assertTargetRefMergeAllowed(unrestricted, undefined)).not.toThrow();
  });

  it('allows an exact and a wildcard target ref', () => {
    expect(() => assertTargetRefMergeAllowed(restricted, 'refs/heads/develop')).not.toThrow();
    expect(() => assertTargetRefMergeAllowed(restricted, 'refs/heads/release/1.2')).not.toThrow();
  });

  it('refuses a target ref outside the allowed list', () => {
    expect(() => assertTargetRefMergeAllowed(restricted, 'refs/heads/master')).toThrow(/refs\/heads\/master is not allowed/);
  });

  it('refuses when the target ref is unknown but restrictions apply', () => {
    expect(() => assertTargetRefMergeAllowed(restricted, undefined)).toThrow(/Could not determine the target branch/);
  });
});
