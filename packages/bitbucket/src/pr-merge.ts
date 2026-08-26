import { handleApiOperation } from '@atlassian-dc-mcp/common';
import { PullRequestsService } from './bitbucket-client/index.js';
import {
  BitbucketMutationOutputMode,
  shapeMergeability,
  shapePullRequestAck,
} from './bitbucket-response-mapper.js';
import { assertRepoMergeAllowed, assertTargetRefMergeAllowed, type MergeGateway } from './merge-gateway.js';

export interface MergePullRequestParams {
  projectKey: string;
  repositorySlug: string;
  pullRequestId: string;
  /** Current PR version, required for optimistic locking. */
  version: number;
  gateway: MergeGateway;
  strategyId?: string;
  message?: string;
  output?: BitbucketMutationOutputMode;
}

/** Read-only mergeability check: reports conflicts and merge-check vetoes. */
export async function fetchMergeability(projectKey: string, repositorySlug: string, pullRequestId: string) {
  const result = await handleApiOperation(
    () => PullRequestsService.canMerge(projectKey, pullRequestId, repositorySlug),
    'Error checking pull request mergeability',
  );

  if (result.success && result.data) {
    return { ...result, data: shapeMergeability(result.data) };
  }

  return result;
}

function describeVetoes(vetoes: Array<{ summary?: string; detail?: string }>): string {
  return vetoes
    .map(veto => [veto.summary, veto.detail].filter(Boolean).join(' — '))
    .filter(Boolean)
    .join('; ');
}

async function assertMergeable(projectKey: string, repositorySlug: string, pullRequestId: string): Promise<void> {
  const mergeability = shapeMergeability(
    await PullRequestsService.canMerge(projectKey, pullRequestId, repositorySlug),
  );
  if (mergeability.canMerge) {
    return;
  }
  const cause = mergeability.conflicted ? 'it has conflicts' : 'a merge check vetoed the merge';
  const reasons = describeVetoes(mergeability.vetoes);
  throw new Error(`Pull request cannot be merged: ${cause}${reasons ? `. ${reasons}` : ''}`);
}

/** Only fetches the pull request when the operator restricts target branches. */
async function assertTargetRefAllowed(params: MergePullRequestParams): Promise<void> {
  if (params.gateway.targetRefs.length === 0) {
    return;
  }
  const pullRequest: any = await PullRequestsService.get3(
    params.projectKey,
    params.pullRequestId,
    params.repositorySlug,
  );
  assertTargetRefMergeAllowed(params.gateway, pullRequest?.toRef?.id);
}

/**
 * Merge a pull request under the operator's merge policy. Order matters: the repository
 * (and target branch, when restricted) is checked before any request, and the mergeability
 * check runs before the POST so a conflicted or vetoed pull request is refused without
 * issuing the write.
 */
export async function mergePullRequest(params: MergePullRequestParams) {
  const { projectKey, repositorySlug, pullRequestId, version, gateway } = params;

  const result = await handleApiOperation(async () => {
    assertRepoMergeAllowed(gateway, projectKey, repositorySlug);
    await assertTargetRefAllowed(params);
    await assertMergeable(projectKey, repositorySlug, pullRequestId);

    return PullRequestsService.merge(projectKey, pullRequestId, repositorySlug, String(version), {
      version,
      ...(params.strategyId ? { strategyId: params.strategyId } : {}),
      ...(params.message ? { message: params.message } : {}),
    });
  }, 'Error merging pull request');

  if (result.success && result.data && params.output !== 'full') {
    return { ...result, data: shapePullRequestAck(result.data) };
  }

  return result;
}
