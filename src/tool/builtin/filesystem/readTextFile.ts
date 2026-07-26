import { stat, readFile } from "node:fs/promises";
import { RigoriumToolRuntimeError } from "../../protocol/errors.js";

export async function readTextFile(filePath: string): Promise<string> {
  const fileStat = await stat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RigoriumToolRuntimeError("file_not_found", `File ${filePath} does not exist.`);
    }
    throw error;
  });

  if (!fileStat.isFile()) {
    throw new RigoriumToolRuntimeError("file_conflict", `${filePath} is not a regular file.`);
  }

  const buffer = await readFile(filePath);
  if (buffer.includes(0)) {
    throw new RigoriumToolRuntimeError("invalid_tool_input", `${filePath} appears to be a binary file.`);
  }

  return buffer.toString("utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
