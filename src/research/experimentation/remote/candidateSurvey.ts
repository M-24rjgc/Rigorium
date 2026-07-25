export type RemoteExecutionCandidate = Readonly<{
  name: string;
  inspectedVersion: string;
  license: string;
  runtime: string;
  evidenceUrl: string;
  maintained: boolean;
  adoption: "direct" | "thin_adapter" | "excluded";
  reason: string;
}>;

/**
 * Evidence captured on 2026-07-25 from the local runtime, package registries,
 * upstream repositories, and SchedMD command documentation. No candidate was
 * installed as part of this survey.
 */
export const REMOTE_EXECUTION_CANDIDATE_SURVEY = Object.freeze({
  auditedAt: "2026-07-25",
  candidates: Object.freeze([
    {
      name: "OpenSSH for Windows",
      inspectedVersion: "OpenSSH_for_Windows_9.5p2",
      license: "OpenSSH BSD-style license",
      runtime: "C:\\Windows\\System32\\OpenSSH\\ssh.exe (present)",
      evidenceUrl: "https://github.com/PowerShell/Win32-OpenSSH",
      maintained: true,
      adoption: "direct",
      reason: "OS-managed client is already present and can carry one fixed remote-agent command with JSON over stdin.",
    },
    {
      name: "ssh2",
      inspectedVersion: "1.17.0",
      license: "MIT",
      runtime: "Node >=10.16; not installed in this workspace",
      evidenceUrl: "https://github.com/mscdex/ssh2",
      maintained: true,
      adoption: "excluded",
      reason: "A new dependency would not remove the SSH exec channel's command-string boundary; direct OpenSSH is sufficient.",
    },
    {
      name: "node-ssh",
      inspectedVersion: "13.2.1",
      license: "MIT",
      runtime: "Node >=10; depends on ssh2 and shell-escape; not installed",
      evidenceUrl: "https://github.com/steelbrain/node-ssh",
      maintained: true,
      adoption: "excluded",
      reason: "Its command-oriented convenience API and shell-escape dependency conflict with the structured remote-agent protocol.",
    },
    {
      name: "ssh2-sftp-client",
      inspectedVersion: "12.1.1",
      license: "Apache-2.0",
      runtime: "Node >=18.20.4; depends on ssh2; not installed",
      evidenceUrl: "https://github.com/theophilusx/ssh2-sftp-client",
      maintained: true,
      adoption: "excluded",
      reason: "It addresses SFTP only; hash-checked staging is handled by the same authenticated JSON agent without another dependency.",
    },
    {
      name: "Slurm official CLI",
      inspectedVersion: "remote-cluster supplied",
      license: "GPL-2.0-or-later upstream program; invoked, not redistributed",
      runtime: "sbatch, squeue, sacct, and scancel on a configured Linux cluster",
      evidenceUrl: "https://slurm.schedmd.com/sbatch.html",
      maintained: true,
      adoption: "thin_adapter",
      reason: "Official parsable submission, query, accounting, and cancellation interfaces preserve scheduler job IDs directly.",
    },
    {
      name: "Submitit",
      inspectedVersion: "1.5.4",
      license: "MIT",
      runtime: "Python >=3.8; not installed in this workspace",
      evidenceUrl: "https://github.com/facebookincubator/submitit",
      maintained: true,
      adoption: "excluded",
      reason: "It is optimized for serialized Python callables; the host needs language-neutral argv jobs and no bundled Python control plane.",
    },
  ] satisfies readonly RemoteExecutionCandidate[]),
  decision: Object.freeze({
    ssh: "Use the installed OpenSSH client only as transport to a fixed Rigorium remote agent.",
    slurm: "Use official Slurm CLI commands behind that agent through a thin structured adapter.",
    staging: "Send bounded file bytes and SHA-256 digests through the agent; never interpolate local paths into remote commands.",
  }),
});
