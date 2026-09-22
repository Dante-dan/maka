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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runtimeHostStartupTaskPhases,
  runtimeHostStartupTaskPlan,
} from '../runtime-host-post-startup-tasks.js';
import {
  createStartupTaskRegistry,
} from '../startup-task-registry.js';

test('production plan preserves the three independent startup gates', () => {
  assert.deepEqual(
    runtimeHostStartupTaskPlan
      .filter(({ phase }) => phase === runtimeHostStartupTaskPhases.immediate)
      .map(({ name }) => name),
    [
      'start-desktop-background-services',
      'resolve-shell-env',
      'start-mcp',
      'resume-mcp-logins',
      'refresh-client-settings',
    ],
  );
  assert.deepEqual(
    runtimeHostStartupTaskPlan
      .filter(({ phase }) => phase === runtimeHostStartupTaskPhases.shellEnvReady)
      .map(({ name }) => name),
    ['start-enabled-runtime-host-profiles'],
  );
  assert.deepEqual(
    runtimeHostStartupTaskPlan
      .filter(({ phase }) => phase === runtimeHostStartupTaskPhases.runtimeHostReady)
      .map(({ name }) => name),
    [
      'restore-guest-session-mounts',
      'recover-local-runtime-host-access',
      'offer-unavailable-default-runtime-host',
    ],
  );
});

test('every production task that can spawn depends on shell environment resolution', () => {
  const byName = new Map(
    runtimeHostStartupTaskPlan.map((definition) => [definition.name, definition]),
  );
  const dependsOnShellEnvironment = (name: string, visited = new Set<string>()): boolean => {
    if (name === 'resolve-shell-env') return true;
    if (visited.has(name)) return false;
    visited.add(name);
    const definition = byName.get(name as (typeof runtimeHostStartupTaskPlan)[number]['name']);
    return definition?.dependencies.some((dependency) =>
      dependsOnShellEnvironment(dependency, visited),
    ) ?? false;
  };

  const spawnCapableTasks = runtimeHostStartupTaskPlan.filter(
    ({ spawnPolicy }) => spawnPolicy === 'requires-shell-environment',
  );
  assert.deepEqual(
    spawnCapableTasks.map(({ name }) => name),
    [
      'start-mcp',
      'resume-mcp-logins',
      'start-enabled-runtime-host-profiles',
      'recover-local-runtime-host-access',
    ],
  );
  assert.deepEqual(
    spawnCapableTasks.filter(({ name }) => !dependsOnShellEnvironment(name)),
    [],
  );
});

test('production spawn-capable tasks cannot start before shell environment resolution', async () => {
  const events: string[] = [];
  let finishShell!: () => void;
  let markShellStarted!: () => void;
  const shellStarted = new Promise<void>((resolve) => {
    markShellStarted = resolve;
  });
  const shellReady = new Promise<void>((resolve) => {
    finishShell = resolve;
  });
  const registry = createStartupTaskRegistry(runtimeHostStartupTaskPlan, {
    'start-desktop-background-services': () => events.push('background-services'),
    'resolve-shell-env': async () => {
      events.push('shell-env:start');
      markShellStarted();
      await shellReady;
      events.push('shell-env:done');
    },
    'start-mcp': () => events.push('mcp'),
    'resume-mcp-logins': () => events.push('mcp-logins'),
    'refresh-client-settings': () => events.push('client-settings'),
    'start-enabled-runtime-host-profiles': () => events.push('runtime-host-profiles'),
    'restore-guest-session-mounts': () => events.push('guest-session-mounts'),
    'recover-local-runtime-host-access': () => events.push('local-runtime-host-recovery'),
    'offer-unavailable-default-runtime-host': () => events.push('default-runtime-host-offer'),
  });

  const immediate = registry.runPhase(runtimeHostStartupTaskPhases.immediate);
  await shellStarted;
  assert.deepEqual(events, ['background-services', 'shell-env:start']);

  finishShell();
  await immediate;
  await registry.runPhase(runtimeHostStartupTaskPhases.shellEnvReady);
  await registry.runPhase(runtimeHostStartupTaskPhases.runtimeHostReady);

  const shellReadyIndex = events.indexOf('shell-env:done');
  for (const task of [
    'mcp',
    'mcp-logins',
    'runtime-host-profiles',
    'local-runtime-host-recovery',
  ]) {
    assert.ok(events.indexOf(task) > shellReadyIndex, `${task} started before shell environment`);
  }
});

test('uses definition order as the deterministic tiebreak for dependency peers', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry(
    [
      { name: 'root', phase: 'test', dependencies: [] },
      { name: 'defined-second', phase: 'test', dependencies: ['root'] },
      { name: 'defined-first', phase: 'test', dependencies: ['root'] },
      {
        name: 'last',
        phase: 'test',
        dependencies: ['defined-first', 'defined-second'],
      },
    ] as const,
    {
      'defined-first': () => events.push('defined-first'),
      root: () => events.push('root'),
      last: () => events.push('last'),
      'defined-second': () => events.push('defined-second'),
    },
  );

  await registry.runAll();

  assert.deepEqual(events, ['root', 'defined-second', 'defined-first', 'last']);
});

test('runs only the selected phase while preserving its dependencies', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry(
    [
      { name: 'immediate', phase: 'immediate', dependencies: [] },
      { name: 'recovery', phase: 'recovery', dependencies: [] },
      { name: 'after-recovery', phase: 'recovery', dependencies: ['recovery'] },
    ] as const,
    {
      immediate: () => events.push('immediate'),
      recovery: () => events.push('recovery'),
      'after-recovery': () => events.push('after-recovery'),
    },
  );

  await registry.runPhase('immediate');
  assert.deepEqual(events, ['immediate']);

  await registry.runPhase('recovery');
  assert.deepEqual(events, ['immediate', 'recovery', 'after-recovery']);
});

test('retains completed dependencies across phase gates', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry(
    [
      { name: 'prepare', phase: 'early', dependencies: [] },
      { name: 'consume', phase: 'late', dependencies: ['prepare'] },
    ] as const,
    {
      prepare: () => events.push('prepare'),
      consume: () => events.push('consume'),
    },
  );

  await registry.runPhase('early');
  await registry.runPhase('late');

  assert.deepEqual(events, ['prepare', 'consume']);
});

test('detached tasks do not block the graph', async () => {
  const events: string[] = [];
  let finishBackground: (() => void) | undefined;
  const background = new Promise<void>((resolve) => {
    finishBackground = resolve;
  });
  const registry = createStartupTaskRegistry(
    [
      { name: 'foreground', phase: 'test', dependencies: [] },
      {
        name: 'background',
        phase: 'test',
        dependencies: ['foreground'],
        execution: 'detached',
      },
      { name: 'after-start', phase: 'test', dependencies: ['background'] },
    ] as const,
    {
      foreground: () => events.push('foreground'),
      background: async () => {
        events.push('background:start');
        await background;
        events.push('background:done');
      },
      'after-start': () => events.push('after-start'),
    },
  );

  await registry.runAll();
  assert.deepEqual(events, ['foreground', 'background:start', 'after-start']);

  finishBackground?.();
  await background;
  await Promise.resolve();

  assert.deepEqual(events, [
    'foreground',
    'background:start',
    'after-start',
    'background:done',
  ]);
});

test('synchronous detached failures do not block later tasks', async () => {
  const events: string[] = [];
  const registry = createStartupTaskRegistry(
    [
      { name: 'throws', phase: 'test', dependencies: [], execution: 'detached' },
      { name: 'later', phase: 'test', dependencies: [] },
    ] as const,
    {
      throws: () => {
        events.push('throws');
        throw new Error('detached failure');
      },
      later: () => events.push('later'),
    },
  );

  await registry.runAll();
  assert.deepEqual(events, ['throws', 'later']);
});

test('validates the complete graph before executing any task', async () => {
  assert.throws(
    () =>
      createStartupTaskRegistry([
        { name: 'dependent', phase: 'test', dependencies: ['missing'] },
      ]),
    /unknown startup task dependency: missing/u,
  );

  assert.throws(
    () =>
      createStartupTaskRegistry([
        { name: 'first', phase: 'test', dependencies: ['second'] },
        { name: 'second', phase: 'test', dependencies: ['first'] },
      ] as const, {
        first: () => undefined,
        second: () => undefined,
      }),
    /startup task dependency cycle/u,
  );
  assert.throws(
    () =>
      createStartupTaskRegistry(
        [
          { name: 'registered', phase: 'test', dependencies: [] },
          { name: 'missing', phase: 'test', dependencies: ['registered'] },
        ] as const,
        { registered: () => undefined },
      ),
    /startup task is not implemented: missing/u,
  );
});
