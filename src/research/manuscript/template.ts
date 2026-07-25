import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ManuscriptTemplatePin, TemplateProbe } from "./types.js";
import { hashBytes, requirePositiveInteger } from "./validation.js";

export const ICLR_2026_TEMPLATE_PIN: ManuscriptTemplatePin = Object.freeze({
  provider: "iclr",
  conferenceYear: 2026,
  officialPageUrl: "https://iclr.cc/Conferences/2026/AuthorGuide",
  repositoryUrl: "https://github.com/ICLR/Master-Template",
  commit: "a28d335b0d46a3c39b205704a65faf41c9748433",
  archiveUrl: "https://raw.githubusercontent.com/ICLR/Master-Template/a28d335b0d46a3c39b205704a65faf41c9748433/iclr2026.zip",
  archiveSha256: "sha256:b6d63b29992e153f804bb6d170c57db156c011b5bedf96a9f31d58813b909acf",
  archiveBytes: 241_296,
  requiredFiles: Object.freeze([
    "fancyhdr.sty",
    "iclr2026_conference.bst",
    "iclr2026_conference.sty",
    "math_commands.tex",
    "natbib.sty",
  ]),
  licenseStatus: "not_declared_by_repository",
  redistribution: "external_fetch_or_user_supplied_only",
  verifiedAt: "2026-07-25T00:00:00.000Z",
});

export function getOfficialIclrTemplatePin(conferenceYear: number): ManuscriptTemplatePin | undefined {
  requirePositiveInteger(conferenceYear, "conferenceYear", 9_999);
  return conferenceYear === ICLR_2026_TEMPLATE_PIN.conferenceYear ? ICLR_2026_TEMPLATE_PIN : undefined;
}

export async function probeIclrTemplate(input: {
  conferenceYear: number;
  archivePath?: string;
  directoryPath?: string;
}): Promise<TemplateProbe> {
  const conferenceYear = requirePositiveInteger(input.conferenceYear, "conferenceYear", 9_999);
  const pin = getOfficialIclrTemplatePin(conferenceYear);
  if (!pin) {
    return Object.freeze({
      provider: "iclr" as const,
      conferenceYear,
      status: "unverified_year" as const,
      diagnostics: Object.freeze([
        `No official ICLR ${conferenceYear} template pin has been verified. Supply and review an official venue source before rendering.`,
      ]),
    });
  }
  const diagnostics: string[] = [];
  let archive: TemplateProbe["archive"];
  let directory: TemplateProbe["directory"];
  let archiveStatus: "missing" | "hash_mismatch" | "verified" | undefined;
  let directoryStatus: "missing" | "incomplete" | "structure_verified" | undefined;

  if (input.archivePath !== undefined) {
    const path = resolve(input.archivePath);
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        archiveStatus = "missing";
        diagnostics.push("The template archive path is not a regular non-symlink file.");
      } else {
        const contentHash = hashBytes(await readFile(path));
        archive = Object.freeze({ path, bytes: stats.size, contentHash });
        archiveStatus = contentHash === pin.archiveSha256 && stats.size === pin.archiveBytes ? "verified" : "hash_mismatch";
        if (archiveStatus === "hash_mismatch") diagnostics.push("The template archive does not match the pinned official SHA-256 and byte length.");
      }
    } catch (error) {
      archiveStatus = "missing";
      diagnostics.push(`The template archive could not be inspected: ${errorMessage(error)}`);
    }
  }

  if (input.directoryPath !== undefined) {
    const path = resolve(input.directoryPath);
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        directoryStatus = "missing";
        diagnostics.push("The template directory path is not a regular non-symlink directory.");
      } else {
        const entries = await readdir(path, { withFileTypes: true });
        const presentFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
        const presentSet = new Set(presentFiles);
        const missingFiles = pin.requiredFiles.filter((file) => !presentSet.has(file));
        directory = Object.freeze({ path, presentFiles: Object.freeze(presentFiles), missingFiles: Object.freeze(missingFiles) });
        directoryStatus = missingFiles.length === 0 ? "structure_verified" : "incomplete";
        if (missingFiles.length > 0) diagnostics.push(`Template directory is missing: ${missingFiles.join(", ")}.`);
        if (missingFiles.length === 0) diagnostics.push("Required files are present, but directory structure alone does not prove archive integrity.");
      }
    } catch (error) {
      directoryStatus = "missing";
      diagnostics.push(`The template directory could not be inspected: ${errorMessage(error)}`);
    }
  }

  let status: TemplateProbe["status"];
  if (archiveStatus === "hash_mismatch") status = "hash_mismatch";
  else if (directoryStatus === "incomplete") status = "incomplete";
  else if (archiveStatus === "verified" && (directoryStatus === undefined || directoryStatus === "structure_verified")) status = "verified";
  else if (directoryStatus === "structure_verified") status = "structure_verified";
  else status = "missing";
  if (input.archivePath === undefined && input.directoryPath === undefined) diagnostics.push("No local archive or template directory was supplied.");

  return Object.freeze({
    provider: "iclr" as const,
    conferenceYear,
    status,
    pin,
    ...(archive === undefined ? {} : { archive }),
    ...(directory === undefined ? {} : { directory }),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function templateStylePackage(pin: ManuscriptTemplatePin): string {
  return basename(pin.requiredFiles.find((file) => file.endsWith("_conference.sty")) ?? "", ".sty");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

