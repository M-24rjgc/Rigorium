import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createCollisionResistantProjectId as createCoreCollisionId,
    createProjectId as createCoreProjectId,
    resolveProjectStorageId as resolveCoreProjectStorageId,
} from '../../../src/rigorium/paths.js';
import {
    createCollisionResistantProjectId,
    createProjectId,
    resolveProjectStorageId,
} from './rigoriumPaths.js';
import { getAlwaysOnRoot } from '../services/always-on-paths.js';

describe('UI project storage ID resolution', () => {
    it('matches the core resolver for colliding non-ASCII workspaces', () => {
        const root = mkdtempSync(join(tmpdir(), 'rigorium-ui-project-id-'));
        try {
            const rigoriumHome = join(root, 'rigorium-home');
            const projectA = join(root, 'home', '内部测试');
            const projectB = join(root, 'home', '会议纪要');
            mkdirSync(projectA, { recursive: true });
            mkdirSync(projectB, { recursive: true });

            const legacyId = createProjectId(projectA);
            const collisionId = createCollisionResistantProjectId(projectB);
            expect(createProjectId(projectB)).toBe(legacyId);

            mkdirSync(join(rigoriumHome, 'projects', legacyId), { recursive: true });
            writeFileSync(join(rigoriumHome, 'projects', legacyId, '.cwd'), projectA, 'utf8');
            mkdirSync(join(rigoriumHome, 'projects', collisionId), { recursive: true });
            writeFileSync(join(rigoriumHome, 'projects', collisionId, '.cwd'), projectB, 'utf8');

            expect(createProjectId(projectA)).toBe(createCoreProjectId(projectA));
            expect(collisionId).toBe(createCoreCollisionId(projectB));
            expect(resolveProjectStorageId(projectA, rigoriumHome)).toBe(legacyId);
            expect(resolveProjectStorageId(projectB, rigoriumHome)).toBe(collisionId);
            expect(resolveProjectStorageId(projectA, rigoriumHome)).toBe(
                resolveCoreProjectStorageId(projectA, rigoriumHome),
            );
            expect(resolveProjectStorageId(projectB, rigoriumHome)).toBe(
                resolveCoreProjectStorageId(projectB, rigoriumHome),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('matches core fallback behavior for missing and invalid markers', () => {
        const root = mkdtempSync(join(tmpdir(), 'rigorium-ui-project-id-fallback-'));
        try {
            const rigoriumHome = join(root, 'rigorium-home');
            const projectRoot = join(root, 'workspace', 'ascii-project');
            mkdirSync(projectRoot, { recursive: true });

            const invalidId = createCollisionResistantProjectId(projectRoot);
            mkdirSync(join(rigoriumHome, 'projects', invalidId), { recursive: true });
            writeFileSync(join(rigoriumHome, 'projects', invalidId, '.cwd'), join(root, 'missing'), 'utf8');

            expect(resolveProjectStorageId(projectRoot, rigoriumHome)).toBe(createProjectId(projectRoot));
            expect(resolveProjectStorageId(projectRoot, rigoriumHome)).toBe(
                resolveCoreProjectStorageId(projectRoot, rigoriumHome),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('uses the resolved storage ID for the UI Always-On root', () => {
        const root = mkdtempSync(join(tmpdir(), 'rigorium-ui-always-on-root-'));
        const previousRigoriumHome = process.env.RIGORIUM_HOME;
        try {
            const rigoriumHome = join(root, 'rigorium-home');
            const projectRoot = join(root, 'home', '会议纪要');
            const projectId = createCollisionResistantProjectId(projectRoot);
            mkdirSync(projectRoot, { recursive: true });
            mkdirSync(join(rigoriumHome, 'projects', projectId), { recursive: true });
            writeFileSync(join(rigoriumHome, 'projects', projectId, '.cwd'), projectRoot, 'utf8');
            process.env.RIGORIUM_HOME = rigoriumHome;

            expect(getAlwaysOnRoot(projectRoot)).toBe(
                join(rigoriumHome, 'always-on', 'projects', projectId),
            );
        } finally {
            if (previousRigoriumHome === undefined) {
                delete process.env.RIGORIUM_HOME;
            } else {
                process.env.RIGORIUM_HOME = previousRigoriumHome;
            }
            rmSync(root, { recursive: true, force: true });
        }
    });
});
