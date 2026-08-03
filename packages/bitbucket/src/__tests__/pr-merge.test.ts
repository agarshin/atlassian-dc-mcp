import { PullRequestsService } from '../bitbucket-client/index.js';
import { fetchMergeability, mergePullRequest } from '../pr-merge.js';
import type { MergeGateway } from '../merge-gateway.js';

jest.mock('../bitbucket-client/index.js', () => ({
  PullRequestsService: {
    canMerge: jest.fn(),
    merge: jest.fn(),
    get3: jest.fn(),
  },
  OpenAPI: { BASE: '', TOKEN: '', VERSION: '' },
}));

const canMerge = PullRequestsService.canMerge as jest.Mock;
const merge = PullRequestsService.merge as jest.Mock;
const getPullRequest = PullRequestsService.get3 as jest.Mock;

const OPEN_GATEWAY: MergeGateway = { enabled: true, repos: ['PROJ/demo'], targetRefs: [] };
const CLEAN = { canMerge: true, conflicted: false, outcome: 'CLEAN', vetoes: [] };
const MERGED_PR = {
  id: 42,
  version: 3,
  title: 'Add merge tool',
  state: 'MERGED',
  fromRef: { id: 'refs/heads/feature' },
  toRef: { id: 'refs/heads/develop' },
  reviewers: [],
};

const baseParams = {
  projectKey: 'PROJ',
  repositorySlug: 'demo',
  pullRequestId: '42',
  version: 2,
};

describe('fetchMergeability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shapes vetoes into summary/detail pairs', async () => {
    canMerge.mockResolvedValue({
      canMerge: false,
      conflicted: false,
      outcome: 'VETOED',
      vetoes: [{ summaryMessage: 'Not enough approvals', detailedMessage: '2 required, 1 given' }],
    });

    const result = await fetchMergeability('PROJ', 'demo', '42');

    expect(canMerge).toHaveBeenCalledWith('PROJ', '42', 'demo');
    expect(result.data).toEqual({
      canMerge: false,
      conflicted: false,
      outcome: 'VETOED',
      vetoes: [{ summary: 'Not enough approvals', detail: '2 required, 1 given' }],
    });
  });

  it('reports API failures without shaping', async () => {
    canMerge.mockRejectedValue(new Error('boom'));

    const result = await fetchMergeability('PROJ', 'demo', '42');

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});

describe('mergePullRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('merges with the version as an optimistic lock and returns a compact ack', async () => {
    canMerge.mockResolvedValue(CLEAN);
    merge.mockResolvedValue(MERGED_PR);

    const result = await mergePullRequest({ ...baseParams, gateway: OPEN_GATEWAY });

    expect(merge).toHaveBeenCalledWith('PROJ', '42', 'demo', '2', { version: 2 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 42,
      version: 3,
      title: 'Add merge tool',
      state: 'MERGED',
      fromRefId: 'refs/heads/feature',
      toRefId: 'refs/heads/develop',
      reviewerCount: 0,
    });
  });

  it('passes the strategy and message through, and can return the full payload', async () => {
    canMerge.mockResolvedValue(CLEAN);
    merge.mockResolvedValue(MERGED_PR);

    const result = await mergePullRequest({
      ...baseParams,
      gateway: OPEN_GATEWAY,
      strategyId: 'squash',
      message: 'Squashed',
      output: 'full',
    });

    expect(merge).toHaveBeenCalledWith('PROJ', '42', 'demo', '2', {
      version: 2,
      strategyId: 'squash',
      message: 'Squashed',
    });
    expect(result.data).toBe(MERGED_PR);
  });

  it('refuses without any request when merging is disabled', async () => {
    const result = await mergePullRequest({
      ...baseParams,
      gateway: { enabled: false, repos: [], targetRefs: [] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled on this server/);
    expect(canMerge).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('refuses a repository outside the allowed list without any request', async () => {
    const result = await mergePullRequest({
      ...baseParams,
      repositorySlug: 'other-repo',
      gateway: OPEN_GATEWAY,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not allowed in PROJ\/other-repo/);
    expect(merge).not.toHaveBeenCalled();
  });

  it('refuses a target branch outside the allowed refs and never merges', async () => {
    getPullRequest.mockResolvedValue({ toRef: { id: 'refs/heads/master' } });

    const result = await mergePullRequest({
      ...baseParams,
      gateway: { enabled: true, repos: ['PROJ/demo'], targetRefs: ['refs/heads/develop'] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/refs\/heads\/master is not allowed/);
    expect(canMerge).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('merges when the pull request targets an allowed branch', async () => {
    getPullRequest.mockResolvedValue({ toRef: { id: 'refs/heads/release/1.2' } });
    canMerge.mockResolvedValue(CLEAN);
    merge.mockResolvedValue(MERGED_PR);

    const result = await mergePullRequest({
      ...baseParams,
      gateway: { enabled: true, repos: ['PROJ/demo'], targetRefs: ['refs/heads/release/*'] },
    });

    expect(result.success).toBe(true);
    expect(merge).toHaveBeenCalled();
  });

  it('does not fetch the pull request when target branches are unrestricted', async () => {
    canMerge.mockResolvedValue(CLEAN);
    merge.mockResolvedValue(MERGED_PR);

    await mergePullRequest({ ...baseParams, gateway: OPEN_GATEWAY });

    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('refuses a conflicted pull request before issuing the merge', async () => {
    canMerge.mockResolvedValue({ canMerge: false, conflicted: true, outcome: 'CONFLICTED', vetoes: [] });

    const result = await mergePullRequest({ ...baseParams, gateway: OPEN_GATEWAY });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/has conflicts/);
    expect(merge).not.toHaveBeenCalled();
  });

  it('refuses a vetoed pull request and reports the veto reasons', async () => {
    canMerge.mockResolvedValue({
      canMerge: false,
      conflicted: false,
      vetoes: [{ summaryMessage: 'Unresolved tasks', detailedMessage: '1 open task' }],
    });

    const result = await mergePullRequest({ ...baseParams, gateway: OPEN_GATEWAY });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/merge check vetoed the merge\. Unresolved tasks — 1 open task/);
    expect(merge).not.toHaveBeenCalled();
  });

  it('surfaces a server-side merge failure such as a stale version', async () => {
    canMerge.mockResolvedValue(CLEAN);
    merge.mockRejectedValue({ status: 409, statusText: 'Conflict', body: { errors: [{ message: 'stale' }] } });

    const result = await mergePullRequest({ ...baseParams, gateway: OPEN_GATEWAY });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Error merging pull request: 409 Conflict');
    expect(result.details).toEqual({ errors: [{ message: 'stale' }] });
  });
});
