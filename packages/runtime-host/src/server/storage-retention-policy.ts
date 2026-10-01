/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RETENTION_DAYS,
  decodeStorageRetentionPolicy,
  type RetentionDays,
  type StorageRetentionPolicy,
} from '../protocol/storage-retention.js';
export {
  RETENTION_DAYS,
  decodeStorageRetentionPolicy,
  type RetentionDays,
  type StorageRetentionPolicy,
};
const DEFAULT_POLICY: StorageRetentionPolicy = {
  enabled: false,
  days: 30,
  enabledAt: null,
  revision: 0,
};
export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

/** The destructive opt-in is deliberately outside runtime policy and its import/export. */
export class HostStorageRetentionPolicy {
  readonly #path: string;
  readonly #now: () => number;
  #policy: StorageRetentionPolicy = DEFAULT_POLICY;
  #pending: Promise<unknown> = Promise.resolve();

  private constructor(stateRoot: string, now: () => number) {
    this.#path = join(stateRoot, 'storage-retention.json');
    this.#now = now;
  }

  static async open(
    stateRoot: string,
    now: () => number = Date.now,
  ): Promise<HostStorageRetentionPolicy> {
    const store = new HostStorageRetentionPolicy(stateRoot, now);
    try {
      store.#policy = decodeStorageRetentionPolicy(JSON.parse(await readFile(store.#path, 'utf8')));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    return store;
  }

  snapshot(): StorageRetentionPolicy {
    return { ...this.#policy };
  }

  /** Serialize policy writes with final retirement admission, including its asynchronous commit. */
  withCurrent<T>(
    revision: number,
    operation: (policy: StorageRetentionPolicy) => Promise<T>,
  ): Promise<T | undefined> {
    return this.#serialize(async () => {
      if (!this.#policy.enabled || this.#policy.revision !== revision) return undefined;
      return operation(this.snapshot());
    });
  }

  set(input: {
    enabled: boolean;
    days: RetentionDays;
    expectedRevision: number;
  }): Promise<StorageRetentionPolicy | undefined> {
    return this.#serialize(async () => {
      if (input.expectedRevision !== this.#policy.revision) return undefined;
      if (typeof input.enabled !== 'boolean' || !RETENTION_DAYS.includes(input.days)) {
        throw new Error('Invalid storage retention policy');
      }
      if (input.enabled === this.#policy.enabled && input.days === this.#policy.days)
        return this.snapshot();
      const next = decodeStorageRetentionPolicy({
        enabled: input.enabled,
        days: input.days,
        enabledAt: input.enabled ? this.#now() : null,
        revision: this.#policy.revision + 1,
      });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
      this.#policy = next;
      return this.snapshot();
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => undefined);
    return result;
  }
}

/** A legacy archived task starts aging only when this Host opts in. Equality is not expired. */
export function retentionDeadline(
  policy: StorageRetentionPolicy,
  archivedAt?: number,
): number | null {
  if (!policy.enabled || policy.enabledAt === null) return null;
  return (
    Math.max(archivedAt ?? policy.enabledAt, policy.enabledAt) + policy.days * RETENTION_DAY_MS
  );
}
