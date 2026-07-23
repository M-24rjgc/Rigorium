import type { BackgroundTaskRuntime } from "../../task/runtime/BackgroundTaskRuntime.js";
import { createAgentTool, type CreateAgentToolOptions } from "../builtin/agent.js";
import { createAskUserQuestionTool } from "../builtin/askUserQuestion.js";
import { createBashTool, type CreateBashToolOptions } from "../builtin/bash.js";
import { createEditFileTool } from "../builtin/editFile.js";
import { createEditNotebookTool } from "../builtin/editNotebook.js";
import { createExecuteCodeTool } from "../builtin/executeCode.js";
import { createGlobTool } from "../builtin/glob.js";
import { createGrepTool } from "../builtin/grep.js";
import { createGetCurrentTimeTool } from "../builtin/getCurrentTime.js";
import { createReadFileTool } from "../builtin/readFile.js";
import {
  createLiteratureSearchTool,
  type CreateLiteratureSearchToolOptions,
} from "../builtin/literatureSearch.js";
import {
  createLiteratureExpandTool,
  type CreateLiteratureExpandToolOptions,
} from "../builtin/literatureExpand.js";
import {
  createLiteratureDeepSearchTool,
  type CreateLiteratureDeepSearchToolOptions,
} from "../builtin/literatureDeepSearch.js";
import {
  createLiteratureMapMaintenanceTool,
  type CreateLiteratureMapMaintenanceToolOptions,
} from "../builtin/literatureMaintenance.js";
import {
  createDirectionAssessTool,
  type CreateDirectionAssessToolOptions,
} from "../builtin/directionAssess.js";
import {
  createResearchDirectionSeedTool,
  type CreateResearchDirectionSeedToolOptions,
} from "../builtin/directionSeed.js";
import {
  createResearchDirectionLifecycleTool,
  type CreateResearchDirectionLifecycleToolOptions,
} from "../builtin/directionLifecycle.js";
import {
  createResearchTitleConfirmationTool,
  type CreateResearchTitleConfirmationToolOptions,
} from "../builtin/titleConfirm.js";
import { createSendAttachmentTool } from "../builtin/sendAttachment.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "../builtin/planMode.js";
import { createStructuredOutputTool } from "../builtin/structuredOutput.js";
import { createTodoWriteTool } from "../builtin/todoWrite.js";
import {
  createTaskCreateTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskWaitTool,
} from "../builtin/taskTools.js";
import { createWebFetchTool, type CreateWebFetchToolOptions } from "../builtin/webFetch.js";
import {
  createDeepSeekNativeSearchTool,
  type CreateDeepSeekNativeSearchToolOptions,
} from "../builtin/deepseekNativeSearch.js";
import { createWebSearchTool, type CreateWebSearchToolOptions } from "../builtin/webSearch.js";
import { createReadSkillTool, type ReadSkillDeps } from "../builtin/readSkill.js";
import { createWriteFileTool } from "../builtin/writeFile.js";
import { ToolRegistry } from "./ToolRegistry.js";

export type CreateBuiltinRegistryOptions = {
  bash?: CreateBashToolOptions;
  /**
   * `web_search` defaults to the GLM/Z.AI provider. Pass `false` to skip
   * registering web_search; pass an options object to select GLM or Tavily
   * and customize apiKey / endpoint.
   */
  webSearch?: CreateWebSearchToolOptions | false;
  /** Independent DeepSeek server-side search. It is separate from web_search. */
  deepseekNativeSearch?: CreateDeepSeekNativeSearchToolOptions | false;
  /**
   * `agent` subagent tool. **Opt-in** because it requires a model client at
   * execution time — the AgentLoop forwards the loop's model client through
   * `PilotDeckToolRuntimeContext.model`, but stand-alone tool runtimes (e.g.
   * tests) may not have one. Pass `true` (default) to register; pass `false`
   * to skip; pass an options object to customize the subagent presets or
   * lock the provider/model.
   */
  agent?: CreateAgentToolOptions | boolean;
  /**
   * `web_fetch` builtin tool. **Opt-in** (default: registered) because it
   * issues HTTP requests and a secondary model call. Pass `false` to skip.
   * Pass an options object to override the provider / model id used for the
   * secondary model call. Without a model client the tool returns the raw
   * markdown without summarization.
   */
  webFetch?: CreateWebFetchToolOptions | false;
  /**
   * Background task tools (`task_create` / `task_list` / `task_output` /
   * `task_wait` / `task_stop`). **Opt-in** — pass `{ runtime }` to register; absent or
   * `false` keeps them out of the registry. Stand-alone runtimes that do
   * not provide a `BackgroundTaskRuntime` would otherwise see every call
   * fail with `unsupported_tool`.
   */
  backgroundTasks?: { runtime: BackgroundTaskRuntime } | false;
  /**
   * `structured_output` builtin (A3). Registered by default — the tool is
   * inert without a model client requesting it via `tool_choice`, but the
   * registry must contain it so non-interactive hosts can opt in. Pass
   * `false` to skip.
   */
  structuredOutput?: false;
  /**
   * `ask_user_question` builtin (B1). Registered by default; an absent
   * `PilotDeckElicitationChannel` at execution time causes the tool to
   * return a runtime error rather than crash the loop. Pass `false` to
   * skip registration in headless contexts.
   */
  askUserQuestion?: false;
  /**
   * `read_skill` builtin. **Opt-in** — pass `{ loader, lister }` to
   * register; absent or `false` keeps it out of the registry. The loader
   * fetches skill content by name; the lister enumerates available skill
   * names for the "not found" diagnostic message.
   */
  readSkill?: ReadSkillDeps | false;
  /** Rigorium academic metadata search. Registered by default. */
  literatureSearch?: CreateLiteratureSearchToolOptions | false;
  /** Rigorium OpenAlex citation expansion. Registered by default. */
  literatureExpansion?: CreateLiteratureExpandToolOptions | false;
  /** Rigorium bounded, agent-planned literature search sessions. Registered by default. */
  literatureDeepSearch?: CreateLiteratureDeepSearchToolOptions | false;
  /** Rigorium auditable, candidate-only live literature-map maintenance. */
  literatureMapMaintenance?: CreateLiteratureMapMaintenanceToolOptions | false;
  /** Rigorium side-effect-free research direction assessment. Registered by default. */
  directionAssessment?: CreateDirectionAssessToolOptions | false;
  /** Rigorium cue-to-candidate research direction artifact. Registered by default. */
  researchDirectionSeed?: CreateResearchDirectionSeedToolOptions | false;
  /** Rigorium project-local research direction lifecycle. Registered by default. */
  researchDirectionLifecycle?: CreateResearchDirectionLifecycleToolOptions | false;
  /** Rigorium explicit, side-effect-free title confirmation. Registered by default. */
  researchTitleConfirmation?: CreateResearchTitleConfirmationToolOptions | false;
  /**
   * `enter_plan_mode` / `exit_plan_mode` builtins. Registered by default —
   * these lightweight skeleton tools let the model request a permission-mode
   * switch to plan (read-only) and back. Pass `false` to skip.
   */
  planMode?: false;
};

export function createBuiltinRegistry(options?: CreateBuiltinRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createGetCurrentTimeTool());
  registry.register(createReadFileTool());
  registry.register(createSendAttachmentTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createEditFileTool());
  registry.register(createEditNotebookTool());
  registry.register(createWriteFileTool());
  registry.register(createBashTool(options?.bash));
  registry.register(createExecuteCodeTool());
  if (options?.webSearch !== false) {
    registry.register(createWebSearchTool(options?.webSearch));
  }
  if (options?.deepseekNativeSearch !== false) {
    registry.register(createDeepSeekNativeSearchTool(options?.deepseekNativeSearch));
  }
  if (options?.webFetch !== false) {
    registry.register(createWebFetchTool(options?.webFetch));
  }
  if (options?.literatureSearch !== false) {
    registry.register(createLiteratureSearchTool(options?.literatureSearch));
  }
  if (options?.literatureExpansion !== false) {
    registry.register(createLiteratureExpandTool(options?.literatureExpansion));
  }
  if (options?.literatureDeepSearch !== false) {
    registry.register(createLiteratureDeepSearchTool(options?.literatureDeepSearch));
  }
  if (options?.literatureMapMaintenance !== false) {
    registry.register(createLiteratureMapMaintenanceTool(options?.literatureMapMaintenance));
  }
  if (options?.directionAssessment !== false) {
    registry.register(createDirectionAssessTool(options?.directionAssessment));
  }
  if (options?.researchDirectionSeed !== false) {
    registry.register(createResearchDirectionSeedTool(options?.researchDirectionSeed));
  }
  if (options?.researchDirectionLifecycle !== false) {
    registry.register(createResearchDirectionLifecycleTool(options?.researchDirectionLifecycle));
  }
  if (options?.researchTitleConfirmation !== false) {
    registry.register(createResearchTitleConfirmationTool(options?.researchTitleConfirmation));
  }
  if (options?.agent !== false) {
    const agentOpts = options?.agent === true || options?.agent === undefined ? undefined : options.agent;
    registry.register(createAgentTool(agentOpts));
  }
  if (options?.backgroundTasks) {
    const runtime = options.backgroundTasks.runtime;
    registry.register(createTaskCreateTool(runtime));
    registry.register(createTaskListTool(runtime));
    registry.register(createTaskOutputTool(runtime));
    registry.register(createTaskWaitTool(runtime));
    registry.register(createTaskStopTool(runtime));
  }
  if (options?.structuredOutput !== false) {
    registry.register(createStructuredOutputTool());
  }
  if (options?.askUserQuestion !== false) {
    registry.register(createAskUserQuestionTool());
  }
  if (options?.planMode !== false) {
    registry.register(createEnterPlanModeTool());
    registry.register(createExitPlanModeTool());
  }
  registry.register(createTodoWriteTool());
  if (options?.readSkill) {
    registry.register(createReadSkillTool(options.readSkill));
  }
  return registry;
}
