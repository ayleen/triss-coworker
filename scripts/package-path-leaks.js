// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

const ILLUSTRATIVE_PATHS = [
  /triss MCP: root=\/Users\/me\/projects\/foo \(from cwd\), sandbox=on/gu,
  /outside project root \/Users\/\.\.\.\/X/gu,
];

const LOCAL_PATH_PATTERN = /(?:\/Users\/[A-Za-z0-9._-]+\/|\/Volumes\/[A-Za-z0-9._-]+\/|\/home\/(?!<)[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/mu;

export function containsDeveloperPathLeak(source) {
  const scrubbed = ILLUSTRATIVE_PATHS.reduce(
    (text, pattern) => text.replace(pattern, ''),
    String(source),
  );
  return LOCAL_PATH_PATTERN.test(scrubbed);
}
