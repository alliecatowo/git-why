/**
 * The daemon's wire protocol.
 *
 * Deliberately small and deliberately NOT MCP. `git-why-mcp` already speaks
 * MCP by spawning the CLI, and it will speak to the daemon through this same
 * client, so putting MCP here would mean two encodings of the same operations
 * that could disagree. This carries exactly what a CLI invocation carries.
 *
 * Responses reuse the CLI's own types, so a daemon-served search and a direct
 * search are the same object — a client cannot tell them apart, which is the
 * property that makes `auto` mode safe to default to.
 */

import type { IndexStatus, SearchRequest, SearchResponse } from '../types.js';

export const DAEMON_PROTOCOL_VERSION = 1;

export interface SearchRpc {
  readonly op: 'search';
  readonly cwd: string;
  readonly request: SearchRequest;
}

export interface StatusRpc {
  readonly op: 'status';
  readonly cwd: string;
}

export interface HealthRpc {
  readonly op: 'health';
}

export interface ShutdownRpc {
  readonly op: 'shutdown';
  readonly token: string;
}

export type DaemonRequest = SearchRpc | StatusRpc | HealthRpc | ShutdownRpc;

export interface DaemonHealth {
  readonly protocolVersion: number;
  readonly version: string;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly repositories: number;
  readonly openReaders: number;
  readonly servedRequests: number;
}

export type DaemonResponse =
  | { readonly ok: true; readonly op: 'search'; readonly response: SearchResponse }
  | { readonly ok: true; readonly op: 'status'; readonly status: IndexStatus }
  | { readonly ok: true; readonly op: 'health'; readonly health: DaemonHealth }
  | { readonly ok: true; readonly op: 'shutdown' }
  | {
      readonly ok: false;
      /** A `GitWhyErrorCode` when the failure came from the product itself. */
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };
