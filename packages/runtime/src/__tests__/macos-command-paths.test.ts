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
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveMacosDeveloperExecutableRoots,
  resolveMacosGitReadableFiles,
} from '../sandbox/macos-command-paths.js';

describe('resolveMacosDeveloperExecutableRoots', () => {
  it('accepts canonical and symlinked CommandLineTools layouts', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-clt-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    const alias = join(scratch, 'selected');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    symlinkSync(developer, alias);
    try {
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library)],
      );
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({
          developerDir: alias,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('accepts only the library and SharedFrameworks directories from an Xcode layout', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-xcode-'));
    const contents = join(scratch, 'Xcode-beta.app', 'Contents');
    const developer = join(contents, 'Developer');
    const library = join(developer, 'usr', 'lib');
    const frameworks = join(contents, 'SharedFrameworks');
    mkdirSync(library, { recursive: true });
    mkdirSync(frameworks);
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    try {
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library), realpathSync(frameworks)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects root, home, ordinary directories, and unresolved symlinks', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-invalid-developer-'));
    const ordinary = join(scratch, 'ordinary');
    const dangling = join(scratch, 'dangling');
    mkdirSync(ordinary);
    symlinkSync(join(scratch, 'missing'), dangling);
    try {
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: '/' }), []);
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({ developerDir: scratch, homeDir: scratch }),
        [],
      );
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: ordinary }), []);
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: dangling }), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('uses DEVELOPER_DIR before consulting xcode-select', () => {
    let selected = false;
    resolveMacosDeveloperExecutableRoots({
      developerDir: '/',
      selectDeveloperDir: () => {
        selected = true;
        return undefined;
      },
    });
    assert.equal(selected, false);
  });

  it('rejects a structurally plausible toolchain whose libxcrun is not Apple-signed', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-unsigned-clt-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'not signed');
    try {
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: developer }), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('resolveMacosGitReadableFiles', () => {
  it('returns exact active config, included config, and global excludes files', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-git-config-'));
    const config = join(scratch, 'global.config');
    const included = join(scratch, 'included.config');
    const excludes = join(scratch, 'global.ignore');
    writeFileSync(
      config,
      `[include]\n\tpath = ${included}\n[core]\n\texcludesFile = ${excludes}\n`,
    );
    writeFileSync(included, '[user]\n\tname = Maka Test\n');
    writeFileSync(excludes, '*.secret\n');
    try {
      assert.deepEqual(
        [
          ...resolveMacosGitReadableFiles(
            { ...process.env, HOME: scratch, GIT_CONFIG_GLOBAL: config },
            scratch,
          ),
        ].sort(),
        [config, included, excludes].map((path) => realpathSync(path)).sort(),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('does not admit missing referenced files', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-git-config-missing-'));
    const config = join(scratch, 'global.config');
    writeFileSync(config, `[include]\n\tpath = ${join(scratch, 'missing.config')}\n`);
    try {
      assert.deepEqual(
        resolveMacosGitReadableFiles(
          { ...process.env, HOME: scratch, GIT_CONFIG_GLOBAL: config },
          scratch,
        ),
        [realpathSync(config)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('does not admit credential stores named by Git helpers', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-git-credentials-'));
    const config = join(scratch, 'global.config');
    const credentials = join(scratch, '.git-credentials');
    writeFileSync(config, '[credential]\n\thelper = store\n');
    writeFileSync(credentials, 'https://token@example.test\n');
    try {
      assert.deepEqual(
        resolveMacosGitReadableFiles(
          { ...process.env, HOME: scratch, GIT_CONFIG_GLOBAL: config },
          scratch,
        ),
        [realpathSync(config)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
