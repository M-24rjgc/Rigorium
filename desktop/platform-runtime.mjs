import { join, posix } from 'node:path';

export function packagedEsbuildBinaryPath(resourcesPath, platform = process.platform, arch = process.arch) {
  const packageDirectory = join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${platform}-${arch}`,
  );
  return platform === 'win32'
    ? join(packageDirectory, 'esbuild.exe')
    : join(packageDirectory, 'bin', 'esbuild');
}

export function macOSCommandPath(currentPath, homeDirectory) {
  const entries = String(currentPath || '').split(':').filter(Boolean);
  const additions = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    ...(homeDirectory ? [posix.join(homeDirectory, '.local', 'bin')] : []),
  ];
  return [...new Set([...entries, ...additions])].join(':');
}
