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

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const XCODE_SELECT_TIMEOUT_MS = 1_000;
const GIT_CONFIG_TIMEOUT_MS = 1_000;
const CODESIGN_TIMEOUT_MS = 1_000;

export interface MacosCommandPaths {
  executableRoots: readonly string[];
  runtimeReadableFiles: readonly string[];
}

export interface MacosDeveloperPathOptions {
  developerDir?: string;
  homeDir?: string;
  selectDeveloperDir?: () => string | undefined;
  validateAppleBinary?: (path: string) => boolean;
}

/** Resolve only the dynamic-library directories used by the selected Apple toolchain. */
export function resolveMacosDeveloperExecutableRoots(
  options: MacosDeveloperPathOptions = {},
): readonly string[] {
  const selected =
    options.developerDir?.trim() ||
    (options.selectDeveloperDir ?? readSelectedDeveloperDirectory)();
  if (!selected || !isAbsolute(selected)) return [];

  let developerRoot: string;
  try {
    developerRoot = realpathSync(selected);
  } catch {
    return [];
  }

  const homeRoot = canonicalDirectory(options.homeDir ?? homedir());
  if (developerRoot === '/' || (homeRoot && isPathWithin(developerRoot, homeRoot))) return [];

  const libraryRoot = canonicalDirectory(join(developerRoot, 'usr', 'lib'));
  if (!libraryRoot) return [];
  const xcrunLibrary = canonicalRegularFile(join(libraryRoot, 'libxcrun.dylib'));
  if (!xcrunLibrary || !isPathWithin(xcrunLibrary, libraryRoot)) return [];
  if (!(options.validateAppleBinary ?? validateAppleBinary)(xcrunLibrary)) return [];

  if (basename(developerRoot) === 'CommandLineTools') return [libraryRoot];

  if (basename(developerRoot) !== 'Developer' || basename(dirname(developerRoot)) !== 'Contents') {
    return [];
  }

  const contentsRoot = dirname(developerRoot);
  const sharedFrameworks = join(contentsRoot, 'SharedFrameworks');
  if (!isDirectory(sharedFrameworks)) return [];
  return [libraryRoot, realpathSync(sharedFrameworks)];
}

/**
 * Ask Git which global config/include files are active, then admit only those
 * exact files plus the active global excludes file. Git remains the source of
 * truth for includeIf and path expansion semantics.
 */
export function resolveMacosGitReadableFiles(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): readonly string[] {
  const result = spawnSync(
    '/usr/bin/git',
    ['config', '--global', '--includes', '--show-origin', '--null', '--list'],
    {
      cwd,
      env: { ...env },
      encoding: 'utf8',
      timeout: GIT_CONFIG_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];

  const files = parseGitConfigOrigins(result.stdout);
  const excludes = spawnSync(
    '/usr/bin/git',
    [
      'config',
      '--global',
      '--includes',
      '--show-origin',
      '--null',
      '--path',
      '--get-regexp',
      '^core\\.excludesfile$',
    ],
    {
      cwd,
      env: { ...env },
      encoding: 'utf8',
      timeout: GIT_CONFIG_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if ((excludes.status === 0 || excludes.status === 1) && typeof excludes.stdout === 'string') {
    files.push(...parseGitConfigValues(excludes.stdout));
  }

  return canonicalRegularFiles(files);
}

export function resolveMacosCommandPaths(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): MacosCommandPaths {
  return {
    executableRoots: resolveMacosDeveloperExecutableRoots({
      developerDir: env.DEVELOPER_DIR,
      homeDir: env.HOME,
    }),
    runtimeReadableFiles: resolveMacosGitReadableFiles(env, cwd),
  };
}

function readSelectedDeveloperDirectory(): string | undefined {
  const result = spawnSync('/usr/bin/xcode-select', ['-p'], {
    encoding: 'utf8',
    timeout: XCODE_SELECT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function validateAppleBinary(path: string): boolean {
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', path], {
    timeout: CODESIGN_TIMEOUT_MS,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function parseGitConfigOrigins(output: string): string[] {
  const fields = output.split('\0');
  const files: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const origin = fields[index];
    if (origin?.startsWith('file:')) files.push(origin.slice('file:'.length));
  }
  return files;
}

function parseGitConfigValues(output: string): string[] {
  const fields = output.split('\0');
  const values: string[] = [];
  for (let index = 1; index < fields.length; index += 2) {
    const separator = fields[index]?.indexOf('\n') ?? -1;
    if (separator >= 0) values.push(fields[index].slice(separator + 1));
  }
  return values;
}

function canonicalRegularFiles(paths: readonly string[]): readonly string[] {
  const result = new Set<string>();
  for (const path of paths) {
    if (!path || !isAbsolute(path)) continue;
    try {
      const canonical = realpathSync(path);
      if (statSync(canonical).isFile()) result.add(canonical);
    } catch {
      // Missing or inaccessible config references must not widen the sandbox.
    }
  }
  return [...result];
}

function canonicalDirectory(path: string): string | undefined {
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function canonicalRegularFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const canonical = realpathSync(path);
    return statSync(canonical).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPathWithin(path: string, root: string): boolean {
  const delta = relative(root, path);
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`));
}
